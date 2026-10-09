import { createHash, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { homedir, platform as hostPlatform } from "node:os";
import { join } from "node:path";

import { validateLocalN8nStackMarker, getLocalN8nStackLabels } from "../domain/local-n8n-stack.js";
import { lockDownLocalPath, runLocalProcess, validateLocalDockerHost } from "../infrastructure/local-process.js";
import { resolveLocalN8nStackInstallRoot, writePrivateFile } from "./local-n8n-stack-installer.js";

const FEATURES = Object.freeze({
  chatgpt: { name: "Relmio ChatGPT plan", url: "http://n8n-openai-oauth:10531/v1" },
  "local-model": { name: "Relmio local model", url: "http://n8n-local-model:11434/v1" },
  supergrok: { name: "Relmio SuperGrok", url: "http://n8n-supergrok:14502/v1" },
});
const ID = /^[a-f0-9]{64}$/u;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function localStackCredentialId(installId, feature) {
  if (!/^[a-f0-9]{32}$/u.test(installId) || !Object.hasOwn(FEATURES, feature)) throw new TypeError("Invalid credential identity.");
  let value = BigInt(`0x${createHash("sha256").update(`${installId}:${feature}`).digest("hex")}`);
  let encoded = "";
  for (let index = 0; index < 16; index++) {
    encoded = ALPHABET[Number(value % 62n)] + encoded;
    value /= 62n;
  }
  return encoded;
}

export async function importLocalStackN8nCredential({
  marker, credential, runProcess = runLocalProcess, dockerHost,
  fileSystem = defaultFileSystem, homeDirectory = homedir(),
  env = process.env, platform = hostPlatform(), cwd = process.cwd(),
  lockDownPath = lockDownLocalPath,
} = {}) {
  const feature = credential?.feature;
  const settings = Object.hasOwn(FEATURES, feature ?? "") ? FEATURES[feature] : null;
  const response = { state: "failed", name: settings?.name ?? "Relmio credential" };
  try {
    if (!settings || typeof credential.apiKey !== "string" || !credential.apiKey ||
        credential.apiKey.length > 512 || /[\0\r\n]/u.test(credential.apiKey)) return response;
    const safe = validateLocalN8nStackMarker(marker);
    if (validateLocalDockerHost(dockerHost, { platform }) !== safe.dockerHost) return response;
    const root = await resolveLocalN8nStackInstallRoot({ fileSystem, homeDirectory, env, platform });
    const markerPath = join(root, ".managed-by-relmio.json");
    const markerStat = await fileSystem.lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 4096 ||
        (platform !== "win32" && (markerStat.mode & 0o077) !== 0)) return response;
    await lockDownPath(markerPath, { platform, kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: true });
    const onDisk = validateLocalN8nStackMarker(JSON.parse(await fileSystem.readFile(markerPath, "utf8")));
    if (onDisk.installId !== safe.installId || onDisk.projectName !== safe.projectName ||
        onDisk.dockerHost !== safe.dockerHost) return response;
    const containerName = `${safe.projectName}-n8n-1`;
    const inspected = await runProcess({ file: "docker", args: ["container", "inspect", "--format", "{{json .}}", containerName],
      cwd: root, dockerHost, timeoutMs: 60_000, maxOutputBytes: 32_768 });
    if (inspected.code !== 0 || Buffer.byteLength(inspected.stdout ?? "") > 32_768) return response;
    const container = JSON.parse(inspected.stdout);
    const labels = container?.Config?.Labels;
    if (!ID.test(container?.Id) || container.Name !== `/${containerName}` ||
        container.State?.Running !== true || labels?.["com.docker.compose.project"] !== safe.projectName ||
        labels?.["com.docker.compose.service"] !== "n8n" ||
        Object.entries(getLocalN8nStackLabels(safe)).some(([key, value]) => labels?.[key] !== value)) return response;
    const runtime = join(root, ".runtime");
    const directory = await fileSystem.lstat(runtime);
    if (!directory.isDirectory() || directory.isSymbolicLink() ||
        (platform !== "win32" && (directory.mode & 0o077) !== 0)) return response;
    await lockDownPath(runtime, { platform, verifyOnly: true });
    const recordPath = join(runtime, "credentials.json");
    let previous = {};
    try {
      const stat = await fileSystem.lstat(recordPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 ||
          (platform !== "win32" && (stat.mode & 0o077) !== 0)) return response;
      await lockDownPath(recordPath, { platform, kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: true });
      previous = JSON.parse(await fileSystem.readFile(recordPath, "utf8"));
      if (!previous || typeof previous !== "object" || Array.isArray(previous) ||
          Object.entries(previous).some(([name, entry]) => !Object.hasOwn(FEATURES, name) ||
            entry?.id !== localStackCredentialId(safe.installId, name) ||
            entry.name !== FEATURES[name].name || !Number.isSafeInteger(entry.importedAt))) return response;
    } catch (error) {
      if (error?.code !== "ENOENT") return response;
    }
    const id = localStackCredentialId(safe.installId, feature);
    const input = JSON.stringify([{ id, name: settings.name, type: "openAiApi",
      data: { apiKey: credential.apiKey, url: settings.url } }]);
    const imported = await runProcess({ file: "docker",
      args: ["exec", "-i", container.Id, "n8n", "import:credentials", "--input=/dev/stdin"],
      input, cwd: root, dockerHost, timeoutMs: 60_000, maxOutputBytes: 4096 });
    if (imported.code !== 0) return response;
    const temporary = join(runtime, `credentials.json-${randomUUID()}`);
    await writePrivateFile(fileSystem, temporary,
      `${JSON.stringify({ ...previous, [feature]: { id, name: settings.name, importedAt: Date.now() } })}\n`,
      0o600, { platform, lockDownPath });
    try { await fileSystem.rename(temporary, recordPath); }
    catch { await fileSystem.unlink(temporary); return response; }
    await lockDownPath(recordPath, { platform, kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: true });
    return { state: previous[feature] ? "updated" : "created", name: settings.name };
  } catch {
    return response;
  }
}
