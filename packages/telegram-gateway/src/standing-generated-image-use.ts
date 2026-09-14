import { randomUUID } from "node:crypto";
import type { CompletedStandingResult } from "./standing-model-result.js";
import type { StandingArtifactRuntime } from "./standing-artifact-runtime.js";
import type { StandingBoundActionRuntime } from "./standing-bound-action-runtime.js";
import { STANDING_AVATAR_MAX_BYTES } from "./standing-avatar-policy.js";

/** Host continuation after validated native completion, before capability teardown.
 * The model's pending plan is not a successful mutation. Existing action tools
 * own the durable intent, exact Telegram target, settlement and fresh readback. */
export async function applyGeneratedImageUse(input: Readonly<{
  target: "self-avatar" | "group-avatar"; requestRef: string; completed: CompletedStandingResult;
  artifacts: StandingArtifactRuntime; actions?: StandingBoundActionRuntime; signal: AbortSignal;
}>): Promise<string> {
  const label = input.target === "self-avatar" ? "свою аватарку" : "аватарку беседы";
  const unchanged = `Картинка готова, но изменить ${label} не удалось.`;
  const uncertain = `Картинка готова. Не могу подтвердить, удалось ли изменить ${label}; повторно действие не запускал.`;
  if (input.completed.kind !== "image") return `Генерация не завершилась готовой картинкой; по этому плану ${label} не менял.`;
  if (input.signal.aborted || !input.actions || input.actions.state().blocked || input.artifacts.state().blocked) return unchanged;
  const image = input.completed.image;
  if (image.artifact.origin.requestRef !== input.requestRef || image.artifact.byteLength > STANDING_AVATAR_MAX_BYTES)
    return image.artifact.byteLength > STANDING_AVATAR_MAX_BYTES
      ? `Картинка готова, но для аватарки она больше доступного лимита 8 MiB; ${label} этим действием не менял.` : unchanged;
  const name = input.target === "self-avatar" ? "neurobro_set_avatar" : "neurobro_set_group_avatar";
  const handler = input.actions.handlers.find(value => value.name === name);
  if (!handler) return unchanged;
  let artifactRef: string;
  let bytes: Buffer | undefined;
  try {
    bytes = image.registry.copyBytes(image.artifact.ref);
    artifactRef = input.artifacts.importGeneratedImage(input.requestRef, image.artifact, bytes).ref;
  } catch { return unchanged; }
  finally { bytes?.fill(0); }
  if (input.signal.aborted) return unchanged;
  // A fresh host-owned callRef cannot replay or reset durable operation slots.
  let result: unknown;
  try { result = await handler.call({ artifactRef }, { requestRef: input.requestRef,
    callRef: "host-generated-image-use-" + randomUUID(), signal: input.signal }); }
  catch { return uncertain; }
  try {
    if (!result || typeof result !== "object") return uncertain;
    const value = result as { success?: unknown; contentItems?: readonly { type?: unknown; text?: unknown }[] };
    if (typeof value.success !== "boolean" || !Array.isArray(value.contentItems) || value.contentItems.length !== 1) return uncertain;
    const item = value.contentItems[0];
    if (!item || item.type !== "inputText" || typeof item.text !== "string" || Buffer.byteLength(item.text) > 65536) return uncertain;
    const outcome = JSON.parse(item.text) as { verdict?: unknown; schema?: unknown; code?: unknown };
    if (outcome.verdict === "verified" && value.success === true && !input.signal.aborted && !input.actions.state().blocked)
      return `Картинка готова: изменил ${label} и проверил результат в Telegram.`;
    if (outcome.verdict === "refused" && value.success === false && !input.actions.state().blocked) return unchanged;
    return uncertain;
  } catch { return uncertain; }
}
