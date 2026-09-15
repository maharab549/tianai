# Synology + Cloudflare Tunnel

This deployment keeps the backend, model, database, and uploaded files on the NAS. Friends open one HTTPS hostname through Cloudflare; the backend and database are not published to the Internet.

## Prepare the NAS

1. Install Synology Container Manager and create a shared folder such as `docker/tianai`.
2. Upload this repository into that folder. Do not upload `node_modules`, `frontend/dist`, `backend/dist`, or the local `backend/models` directory; the images build those files and the model is downloaded into a Docker volume.
3. Copy `.env.synology.example` to `.env`, then set `JWT_SECRET`, `CLOUDFLARE_TUNNEL_TOKEN`, the public hostname, and the database/MinIO passwords. Keep `.env` private.

The first start downloads the Qwen3 GGUF model (about 2.5 GB) into the persistent `backend_models` volume. Keep additional free space for uploaded memories and database backups.

The DS925+ is a 64-bit AMD Ryzen V1500B system with 4 GB RAM by default and supports up to 32 GB. The 4B model can run only with enough extra memory for Docker, PostgreSQL, and the model; upgrade the NAS before using it as the primary inference host. On stock memory, uncomment the Qwen3 0.6B settings in `.env.synology.example` instead.

## Configure Cloudflare

Use the existing remotely managed tunnel in Zero Trust:

1. In **Networking > Tunnels**, open the tunnel and copy the Docker token from **Add a replica**. Put that token in `CLOUDFLARE_TUNNEL_TOKEN`; anyone with the token can run the tunnel, so do not commit it.
2. Add a **Published application** route for a hostname such as `ai.example.com`.
3. Set the service URL to `http://frontend:5173`. The `cloudflared` container shares the Compose network and can resolve the `frontend` service by name.
4. Create a Cloudflare Access application for that hostname. Add the friends' email addresses or an appropriate identity provider policy. Cloudflare Access is an extra gate before TiānAI's own account login.

If your tunnel connector already runs directly on the Synology host instead of in this Compose project, do not start the `cloudflared` profile. Point the published route to `http://127.0.0.1:5173` instead.

Cloudflare's public-hostname route maps a hostname to a local service, and the Docker token command is the supported remotely managed deployment path: [Tunnel setup](https://developers.cloudflare.com/tunnel/setup/), [Tunnel tokens](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/), and [routing](https://developers.cloudflare.com/tunnel/concepts/routing/).

## Start the stack

From SSH, or from Container Manager's project terminal:

```bash
cd /volume1/docker/tianai
docker compose --profile tunnel up -d --build
docker compose ps
docker compose logs -f cloudflared frontend backend
```

The public route should reach the frontend only. The frontend Nginx container proxies `/api/*` and `/storage/*` to the backend, so a remote browser never tries to call `localhost` on the friend's computer.

Check locally on the NAS:

```bash
curl http://127.0.0.1:4000/api/health
curl -I http://127.0.0.1:5173
```

Then open `https://ai.example.com` from a device outside the home network. Log in with an account created in the application; do not use the seeded demo account for a public installation.

## Updates and backups

```bash
cd /volume1/docker/tianai
docker compose --profile tunnel pull
docker compose --profile tunnel up -d --build
```

Back up the Docker volumes `tianai_backend_data`, `tianai_backend_storage`, `tianai_backend_models`, `tianai_postgres_data`, and `tianai_minio_data`. The model volume is large but avoids downloading Qwen3 again after a rebuild.

The local learning loop remains active on the NAS. Automatic QLoRA retraining is a separate resource requirement: the current backend image does not contain the Python training stack, and a 4B training run generally needs substantially more RAM than CPU-only inference. Install the trainer environment on a machine with enough RAM/GPU and set `TRAINING_PYTHON`, or leave the learning loop active without weight retraining until that worker is available. The learning profile and job state remain available at `GET /api/learning` for administrators.
