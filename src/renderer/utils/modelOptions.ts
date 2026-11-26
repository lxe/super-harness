import type {
  HarnessCatalog,
  HarnessGroup,
  HarnessModelOption,
} from '../../shared/types';

export const EFFORT_META: Record<string, { label: string; hint: string }> = {
  low: { label: 'Low', hint: 'Fastest responses, light reasoning' },
  medium: { label: 'Medium', hint: 'Balanced speed & reasoning depth' },
  high: { label: 'High', hint: 'Thorough multi-step reasoning' },
  xhigh: { label: 'Extra High', hint: 'Extended deep reasoning' },
  max: { label: 'Max', hint: 'Maximum thinking budget' },
  ultra: { label: 'Ultra', hint: 'Deepest possible reasoning' },
};

export const AGY_EFFORT_SUFFIX_RE = /^(.*)-(low|medium|high|xhigh|max)$/i;

export function formatEffortLabel(level: string): string {
  return EFFORT_META[level.toLowerCase()]?.label ?? level;
}

export function getEffortHint(level: string): string {
  return EFFORT_META[level.toLowerCase()]?.hint ?? '';
}

export interface ResolvedModelControls {
  models: HarnessModelOption[];
  activeModelOption: HarnessModelOption | undefined;
  displayModelLabel: string;
  thinkingLevels: string[];
  activeEffort: string | undefined;
  defaultEffort: string | undefined;
}

export function resolveSessionModelControls(
  harnessGroup: HarnessGroup,
  currentModel: string | undefined,
  currentEffort: string | undefined,
  catalog: HarnessCatalog | null | undefined,
  fallbackHarnessLabel: string
): ResolvedModelControls {
  const catalogModels = catalog?.models[harnessGroup] ?? [];
  const trimmedModel = currentModel?.trim() || undefined;
  const matchedInCatalog = trimmedModel
    ? catalogModels.find((m) => m.id === trimmedModel)
    : undefined;

  // If the session is running an observed model slug not listed in the catalog yet,
  // include it cleanly at the top so the dropdown always reflects reality.
  const models: HarnessModelOption[] =
    trimmedModel && !matchedInCatalog
      ? [
          {
            id: trimmedModel,
            label: trimmedModel,
            reasoningLevels:
              harnessGroup === 'codex'
                ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
                : harnessGroup === 'claude'
                  ? ['low', 'medium', 'high', 'xhigh', 'max']
                  : undefined,
          },
          ...catalogModels,
        ]
      : catalogModels;

  const defaultModelOption = models.find((m) => m.isDefault);
  const activeModelOption = matchedInCatalog || (trimmedModel ? models[0] : defaultModelOption);
  const modelForThinking = activeModelOption || defaultModelOption || models[0];

  let thinkingLevels: string[];
  if (modelForThinking?.reasoningLevels && modelForThinking.reasoningLevels.length > 0) {
    thinkingLevels = modelForThinking.reasoningLevels;
  } else if (harnessGroup === 'codex') {
    thinkingLevels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  } else if (harnessGroup === 'claude') {
    thinkingLevels = ['low', 'medium', 'high', 'xhigh', 'max'];
  } else {
    // Antigravity: only show thinking selector if the active model has sibling effort variants
    // (or if no model is chosen yet and catalog has effort-capable models)
    thinkingLevels = !trimmedModel ? ['low', 'medium', 'high', 'xhigh'] : [];
  }

  const agySuffixMatch =
    harnessGroup === 'antigravity' && trimmedModel
      ? trimmedModel.match(AGY_EFFORT_SUFFIX_RE)
      : null;

  const defaultEffort =
    harnessGroup === 'antigravity'
      ? modelForThinking?.defaultReasoningLevel || catalog?.defaultReasoningEffort?.antigravity
      : catalog?.defaultReasoningEffort?.[harnessGroup] ||
        modelForThinking?.defaultReasoningLevel;

  const activeEffort =
    (agySuffixMatch ? agySuffixMatch[2].toLowerCase() : undefined) ||
    currentEffort?.trim().toLowerCase() ||
    defaultEffort;

  const displayModelLabel =
    activeModelOption?.label || trimmedModel || defaultModelOption?.label || fallbackHarnessLabel;

  return {
    models,
    activeModelOption,
    displayModelLabel,
    thinkingLevels,
    activeEffort,
    defaultEffort,
  };
}

export function resolveModelSelectionChange(
  harnessGroup: HarnessGroup,
  nextModelId: string,
  currentEffort: string | undefined,
  models: HarnessModelOption[]
): { model: string; reasoningEffort?: string } {
  const picked = models.find((m) => m.id === nextModelId);
  if (harnessGroup === 'antigravity') {
    const suffixMatch = nextModelId.match(AGY_EFFORT_SUFFIX_RE);
    return {
      model: nextModelId,
      reasoningEffort: suffixMatch ? suffixMatch[2].toLowerCase() : '',
    };
  }
  const normalizedEffort = currentEffort?.trim().toLowerCase();
  const nextEffort =
    normalizedEffort &&
    picked?.reasoningLevels &&
    !picked.reasoningLevels.includes(normalizedEffort)
      ? ''
      : normalizedEffort;
  return {
    model: nextModelId,
    ...(nextEffort !== undefined ? { reasoningEffort: nextEffort } : {}),
  };
}

export function resolveEffortSelectionChange(
  harnessGroup: HarnessGroup,
  nextEffort: string,
  currentModel: string | undefined,
  models: HarnessModelOption[]
): { model?: string; reasoningEffort: string } {
  const normalized = nextEffort.trim().toLowerCase();
  if (harnessGroup === 'antigravity' && normalized) {
    const active =
      models.find((m) => m.id === currentModel) ||
      models.find((m) => m.isDefault) ||
      models[0];
    const match = active?.id.match(AGY_EFFORT_SUFFIX_RE);
    if (match) {
      const candidateId = `${match[1]}-${normalized}`;
      if (models.some((m) => m.id === candidateId)) {
        return { model: candidateId, reasoningEffort: normalized };
      }
    }
  }
  return { reasoningEffort: normalized };
}
