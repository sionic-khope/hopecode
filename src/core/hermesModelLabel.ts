const BRANDS: Record<string, string> = {
  deepseek: 'DeepSeek',
  gpt: 'GPT',
  glm: 'GLM',
  qwen: 'Qwen',
  kimi: 'Kimi',
  llama: 'Llama',
  claude: 'Claude',
};

/**
 * Display name for Hermes' configured model id: `deepseek/deepseek-v4.1-flash-ultrafast` -> `DeepSeek V4.1 Flash
 * Ultrafast`. The vendor prefix before the slash is dropped, hyphen-separated words are Title Cased, versions
 * (`v4.1`) keep their digits and known brands use their own casing. Unrecognised shapes are returned unchanged.
 */
export function hermesModelLabel(model: string, _provider?: string | null): string {
  const raw = model.trim();
  const name = raw.slice(raw.lastIndexOf('/') + 1);
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return model;
  return name
    .split('-')
    .filter(Boolean)
    .map((w) => {
      const lower = w.toLowerCase();
      if (BRANDS[lower]) return BRANDS[lower];
      if (/^v\d+(\.\d+)*$/.test(lower)) return `V${lower.slice(1)}`;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}
