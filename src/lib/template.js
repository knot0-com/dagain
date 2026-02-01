export function renderTemplate(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(String(value));
  }
  return out;
}

export function formatBullets(items) {
  if (!items || items.length === 0) return "- (none)";
  return items.map((item) => `- ${item}`).join("\n");
}

