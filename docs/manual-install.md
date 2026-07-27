# Beginner manual installation

Use this guide only if the browser wizard cannot be used. The wizard is safer
because it validates names, confirms the host fingerprint, uploads files with
SFTP, and limits the commands it can run.

This guide never changes the existing n8n Compose file or image. It creates a
second Compose project.

## Before starting

You need:

- a local Mac, Windows, or Linux computer with Node.js;
- your VPS IP address;
- the VPS root password;
- the name of the running n8n container;
- an existing Docker network shared by n8n and the reverse proxy, commonly
  named `proxy`.

Replace every example such as `YOUR_VPS_IP` and `n8n-n8n-1` with the value
shown on your own VPS. Never type the asterisks used to hide an IP in a
screenshot.

## Part 1: sign in on your own computer

Open Terminal on your computer, not the Hostinger web terminal:

```bash
npx --yes openai-oauth@2.0.0 login --open --login-timeout-ms 300000
```

Complete the newly opened sign-in page within five minutes. An old sign-in tab
can expire; always use the page opened by the newest command.

Confirm that the local file exists:

```bash
test -s "$HOME/.codex/auth.json" && echo "OAuth file is ready"
```

Do not print the file or paste its contents into chat.

## Part 2: inspect n8n on the VPS

Connect from your computer:

```bash
ssh root@YOUR_VPS_IP
```

The first connection asks whether you trust the SSH fingerprint. Compare the
address carefully, type `yes`, and press Return. When SSH asks for a password,
nothing appears while you type; that is normal.

List the running containers:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

Find the row whose image is `docker.n8n.io/n8nio/n8n`. Copy its container name,
then inspect its networks:

```bash
docker inspect n8n-n8n-1 --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
```

An output such as `proxy` is not “nothing”; it is the network name.

## Part 3: create the separate sidecar project

Still in the VPS terminal:

```bash
install -d -m 0755 /docker/n8n-openai-oauth
install -d -m 0700 -o 1000 -g 1000 /docker/n8n-openai-oauth/auth
```

Create `/docker/n8n-openai-oauth/Dockerfile` with exactly:

```dockerfile
FROM node:22-bookworm-slim

RUN npm install --global --ignore-scripts openai-oauth@2.0.0 \
    && npm cache clean --force

USER node

ENTRYPOINT ["openai-oauth"]
CMD ["--host", "0.0.0.0", "--port", "10531", "--oauth-file", "/home/node/.codex/auth.json"]
```

The `CMD` must stay on one line. If the JSON array is split incorrectly,
Docker reports `unknown instruction: "--host"`.

Create `/docker/n8n-openai-oauth/docker-compose.yml` with exactly the following.
If your network is not named `proxy`, change only the final `name: proxy` line.

```yaml
services:
  openai-oauth:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    init: true
    volumes:
      - ./auth:/home/node/.codex
    expose:
      - "10531"
    networks:
      n8n-shared:
        aliases:
          - openai-oauth
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp:size=16m,mode=1777
    pids_limit: 128
    mem_limit: 512m
    cpus: 1.0
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - 'fetch("http://127.0.0.1:10531/health").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    labels:
      io.n8n-openai-oauth.managed: "true"

networks:
  n8n-shared:
    external: true
    name: proxy
```

There is deliberately no `ports:` section and no Traefik label.

## Part 4: copy the OAuth file

Leave the SSH session:

```bash
exit
```

Back in the Terminal on your own computer:

```bash
scp "$HOME/.codex/auth.json" root@YOUR_VPS_IP:/docker/n8n-openai-oauth/auth/auth.json
```

Do not include `**` around the IP. In zsh, asterisks are wildcard characters
and cause `no matches found`.

Return to the VPS:

```bash
ssh root@YOUR_VPS_IP
chown 1000:1000 /docker/n8n-openai-oauth/auth/auth.json
chmod 600 /docker/n8n-openai-oauth/auth/auth.json
```

Run `chown` on the VPS, not on your computer.

## Part 5: validate and start only the sidecar

Use the explicit project name and file on every command:

```bash
docker compose \
  --project-name n8n-openai-oauth \
  --file /docker/n8n-openai-oauth/docker-compose.yml \
  config --quiet
```

Build only `openai-oauth`:

```bash
docker compose \
  --project-name n8n-openai-oauth \
  --file /docker/n8n-openai-oauth/docker-compose.yml \
  build openai-oauth
```

Start only `openai-oauth`, with no dependencies:

```bash
docker compose \
  --project-name n8n-openai-oauth \
  --file /docker/n8n-openai-oauth/docker-compose.yml \
  up -d --wait --wait-timeout 60 --no-deps openai-oauth
```

None of these commands reference the n8n Compose file or service.

## Part 6: verify

Check the final logs:

```bash
docker compose \
  --project-name n8n-openai-oauth \
  --file /docker/n8n-openai-oauth/docker-compose.yml \
  logs --tail=50 openai-oauth
```

The successful lines include:

```text
OpenAI-compatible endpoint ready at http://0.0.0.0:10531/v1
Available Models: ...
```

The warning about `--host 0.0.0.0` is expected inside the container. The
Compose file does not publish the port to the VPS.

Prove that no host port is published:

```bash
docker compose \
  --project-name n8n-openai-oauth \
  --file /docker/n8n-openai-oauth/docker-compose.yml \
  port openai-oauth 10531
```

Success is no output.

Check the models from inside the sidecar:

```bash
docker compose \
  --project-name n8n-openai-oauth \
  --file /docker/n8n-openai-oauth/docker-compose.yml \
  exec -T openai-oauth \
  node -e 'fetch("http://127.0.0.1:10531/v1/models").then(async (response) => { console.log(await response.text()); process.exit(response.ok ? 0 : 1); }).catch(() => process.exit(1))'
```

## Part 7: configure n8n

In the n8n OpenAI credential:

```text
API Key: local-only
Organization ID: leave empty
Base URL: http://openai-oauth:10531/v1
Add Custom Header: off
```

Do not use `http://127.0.0.1:10531/v1` in n8n. Inside the n8n container,
`127.0.0.1` means n8n itself. The Docker service name is `openai-oauth`.

In the OpenAI Chat Model, keep **Use Responses API** on. Choose a model from the
verified list and test a simple prompt before adding tools.
