# Third-party notices

## Airi

The stage composition is inspired by [Airi](https://github.com/maharab549/airi). The legacy `frontend/public/hiyori-preview.png` preview asset remains in the repository for reference but is not rendered by the application.

Copyright (c) 2024-PRESENT Neko Ayaka.

The original Airi source and license are available at <https://github.com/maharab549/airi>. The TiānAI source license does not replace the license for this third-party asset.

## Runtime dependencies and models

Qwen3 GGUF model files are downloaded at runtime and are not included in this repository. The model and its license are provided by the Qwen project.

The default live avatar is `frontend/public/avatars/avatar-sample-a.vrm`, a VRoid Studio sample model from [madjin/vrm-samples](https://github.com/madjin/vrm-samples). It is distributed under the VRoid Studio sample-model conditions described in that project's notice. Replace it with a family-approved VRM model when deploying a personal avatar.

The browser renderer uses [Three.js](https://github.com/mrdoob/three.js) (MIT) and [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) (MIT). Their license files are installed with the frontend packages.

CosyVoice is an optional external service. It is not bundled in this repository and remains subject to its own license at <https://github.com/FunAudioLLM/CosyVoice>.
