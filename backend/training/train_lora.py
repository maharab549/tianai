"""Train a consented QLoRA adapter from TiānAI's approved learning JSONL.

This deliberately trains an adapter, not a replacement base model. The adapter
can be converted to GGUF with llama.cpp's convert_lora_to_gguf.py and then
loaded by node-llama-cpp through LOCAL_LLM_LORA_PATH.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from typing import Any


@dataclass
class Row:
    text: str


class TokenizedDataset:
    def __init__(self, rows: list[Row], tokenizer: Any, max_length: int) -> None:
        self.items: list[dict[str, list[int]]] = []
        for row in rows:
            encoded = tokenizer(row.text, truncation=True, max_length=max_length, padding=False)
            encoded["labels"] = list(encoded["input_ids"])
            self.items.append(encoded)

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: int) -> dict[str, list[int]]:
        return self.items[index]


def read_rows(path: str, tokenizer: Any) -> list[Row]:
    rows: list[Row] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            messages = record.get("messages", [])
            text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
            if text:
                rows.append(Row(text=text))
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--base-model", default="Qwen/Qwen3-4B")
    parser.add_argument("--max-length", type=int, default=2048)
    parser.add_argument("--epochs", type=float, default=3.0)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--gradient-accumulation", type=int, default=8)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--full-precision", action="store_true")
    args = parser.parse_args()

    try:
        import torch
        from transformers import (AutoModelForCausalLM, AutoTokenizer, DataCollatorForSeq2Seq, Trainer, TrainingArguments)
        from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    except ImportError as error:
        raise SystemExit(
            "Training dependencies are missing. Install backend/training/requirements.txt "
            f"in the configured Python environment. Details: {error}"
        ) from error

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    rows = read_rows(args.dataset, tokenizer)
    if len(rows) < 3:
        raise SystemExit("At least three approved learning examples are required")

    use_cuda = torch.cuda.is_available()
    use_bf16 = use_cuda and torch.cuda.is_bf16_supported()
    model_kwargs: dict[str, Any] = {"trust_remote_code": True, "device_map": "auto"}
    if use_cuda:
        model_kwargs["torch_dtype"] = torch.bfloat16 if use_bf16 else torch.float16

    quantized = use_cuda and not args.full_precision
    if quantized:
        try:
            from transformers import BitsAndBytesConfig
            model_kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.bfloat16 if use_bf16 else torch.float16,
                bnb_4bit_use_double_quant=True,
            )
        except ImportError as error:
            raise SystemExit("bitsandbytes is required for the default QLoRA path; rerun with --full-precision") from error

    model = AutoModelForCausalLM.from_pretrained(args.base_model, **model_kwargs)
    if quantized:
        model = prepare_model_for_kbit_training(model)
    model.config.use_cache = False
    model = get_peft_model(model, LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    ))
    model.print_trainable_parameters()

    dataset = TokenizedDataset(rows, tokenizer, args.max_length)
    collator = DataCollatorForSeq2Seq(tokenizer=tokenizer, model=model, padding=True, label_pad_token_id=-100)
    training_args = TrainingArguments(
        output_dir=args.output,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.gradient_accumulation,
        learning_rate=args.learning_rate,
        logging_steps=1,
        save_strategy="epoch",
        report_to=[],
        fp16=use_cuda and not use_bf16,
        bf16=use_bf16,
        gradient_checkpointing=True,
        remove_unused_columns=False,
    )
    Trainer(model=model, args=training_args, train_dataset=dataset, data_collator=collator).train()
    os.makedirs(args.output, exist_ok=True)
    model.save_pretrained(args.output)
    tokenizer.save_pretrained(args.output)
    with open(os.path.join(args.output, "training-manifest.json"), "w", encoding="utf-8") as handle:
        json.dump({"base_model": args.base_model, "examples": len(rows), "quantized": quantized}, handle, indent=2)
    converter = os.environ.get("TRAINING_LORA_CONVERTER", "").strip()
    if converter:
        converted = os.path.join(args.output, "adapter.gguf")
        subprocess.run([
            sys.executable,
            converter,
            "--base-model-id",
            args.base_model,
            "--outfile",
            converted,
            "--outtype",
            "f16",
            "--trust-remote-code",
            args.output,
        ], check=True)
        print(f"GGUF adapter written to {converted}")
    print(f"Adapter written to {args.output}")


if __name__ == "__main__":
    main()
