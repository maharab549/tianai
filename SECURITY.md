# Security policy

TiānAI handles family memories, uploaded files, authentication data, and optional voice references. Treat every deployment as private infrastructure.

## Deployment requirements

- Change `JWT_SECRET`, database passwords, MinIO passwords, and the seeded development password before remote use.
- Keep `.env`, tunnel tokens, model adapters, uploaded files, and Docker volumes private.
- Put Cloudflare Access or an equivalent identity gate in front of a remote deployment.
- Do not expose ports `4000`, `5432`, `9000`, or `9001` directly to the public Internet.
- Keep family-member voice and avatar consent active only when the owner has explicitly granted it.

## Reporting a vulnerability

Please do not open a public issue for a suspected security vulnerability. Use a private GitHub Security Advisory for the repository, or contact the repository owner through the private contact method listed on their GitHub profile. Include a clear description, affected version or commit, reproduction steps, and the impact.
