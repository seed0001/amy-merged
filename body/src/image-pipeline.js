// Independent entry points: ordinary pictures never receive companion identity assets.
export function isSelfImageRequest(text, name = '') {
  const value = String(text ?? '');
  const escaped = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const subject = `(?:you(?:rself)?|your character|${escaped || '(?!)'})`;
  return new RegExp(`\\b(?:image|picture|photo|portrait|drawing|art|painting|illustration)\\s+(?:of|about|featuring)\\s+${subject}\\b|\\b(?:draw|paint|depict|illustrate)\\s+${subject}\\b|\\byour\\s+selfie\\b|\\b(?:send|take|make|create|generate|show)(?: me)?(?: a)? selfie\\b(?!\\s+of\\s+(?!you\\b|yourself\\b))|\\byou\\s+(?:wearing|standing|sitting|posing)\\b`, 'i').test(value);
}

export function directImageIntent(text, rows = [], name = '') {
  if (isSelfImageRequest(text, name)) return 'self';
  const value = String(text ?? '');
  // Recover simple contextual image follow-ups from successful saved tool evidence, without
  // another LLM call. A fresh explicit subject takes precedence over earlier images.
  const followup = /\b(make it|draw it|render it|do it|another one|same (?:image|picture|pose|style)|try again|redo (?:it|that)|this time|different (?:angle|style))\b/i.test(value);
  if (followup) for (const row of [...rows].reverse()) {
    const tools = String(row.tools || '');
    if (/generate_self_image\b[^;]*: ok|look (?:new|setup)\b[^;]*: ok/.test(tools)) return 'self';
    if (/generate_image\b[^;]*: ok/.test(tools)) return 'general';
  }
  if (/\b(draw|paint|illustrate|generate|create|make|show)\b.{0,70}\b(image|picture|photo|portrait|art|illustration|painting)\b|^\s*(?:please\s+)?(?:draw|paint|illustrate)\b/i.test(value)) return 'general';
  return null;
}

// Steers each picture to the right tool. It never refuses changing or replacing her look: that's the
// owner's call, and a wording check here once blocked it nine times in a row.
export function imageRouteError(tool, args, ctx) {
  const requestedSelf = isSelfImageRequest(ctx.userText, ctx.character?.name);
  const promptSelf = isSelfImageRequest(args?.prompt, ctx.character?.name);
  const general = ctx.imageIntent === 'general' && !requestedSelf;
  if (general && tool === 'generate_self_image') return 'This request is for a general image. Call generate_image; do not use or change the companion identity assets.';
  if (general && tool === 'generate_image' && promptSelf) return 'The user requested a general image. Remove the companion from the prompt and use generate_image for the requested subject only.';
  const self = ctx.imageIntent === 'self' || requestedSelf || promptSelf;
  if (tool === 'generate_image' && self) return 'This is a picture of the companion. Call generate_self_image instead; generate_image never uses her identity assets.';
  return null;
}

export async function generateGeneralImage(prompt, { generateImage }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Empty image prompt');
  return generateImage(prompt.trim(), []);
}

// With no reference (a fresh start, or the owner cleared them), the picture is drawn from the request
// alone and saved as her new reference, so the pictures after it keep that face. newReference says so.
export async function generateSelfImage(prompt, { generateImage, referenceImage, activeImage, saveReference, name }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Empty self-image prompt');
  const reference = referenceImage();
  if (!reference) {
    const image = await generateImage(`Create an image of ${name || 'the companion'}, a woman, exactly as described. Produce one image, not a reference sheet or collage. Request: ${prompt.trim()}`, []);
    saveReference?.({ mime: image.mime, bytes: image.bytes, prompt: prompt.trim() });
    return { ...image, newReference: true };
  }
  const active = activeImage?.();
  const references = [reference, ...(active ? [active] : [])];
  return generateImage(`Create an image of ${name || 'the companion'} using the supplied saved identity assets. The first reference is the authoritative identity sheet: preserve her face, hair, skin tone, body type and proportions. ${active ? 'The second reference is her current saved look; use it as supporting identity and clothing context, unless the request specifies different clothing. ' : ''}Follow the requested scene, pose, composition and art style without changing her identity. Produce one image, not a reference sheet or collage. Request: ${prompt.trim()}`, references);
}
