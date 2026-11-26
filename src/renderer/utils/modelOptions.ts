import type {
  HarnessCatalog,
  HarnessGroup,
  HarnessModelOption,
} from '../../shared/types';

export const EFFORT_META: Record<string, { label: string; hint: string }> = {
  none: { label: 'None', hint: 'No extended reasoning' },
  minimal: { label: 'Minimal', hint: 'Briefest reasoning pass' },
  low: { label: 'Low', hint: 'Fastest responses, light reasoning' },
  medium: { label: 'Medium', hint: 'Balanced speed & reasoning depth' },
  high: { label: 'High', hint: 'Thorough multi-step reasoning' },
  xhigh: { label: 'Extra High', hint: 'Extended deep reasoning' },
  max: { label: 'Max', hint: 'Maximum thinking budget' },
  ultra: { label: 'Ultra', hint: 'Deepest possible reasoning' },
};

export const EFFORT_ORDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

export const AGY_EFFORT_SUFFIX_RE = /^(.*)-(none|minimal|low|medium|high|xhigh|max|ultra)$/i;
const LABEL_EFFORT_PARENS_RE =
  /\s*\((?:none|minimal|low|medium|high|xhigh|extra\s+high|max|ultra)\)\s*$/i;

export function stripEffortFromLabel(label: string): string {
  return label.replace(LABEL_EFFORT_PARENS_RE, '').trim();
}

export function sortEffortLevels(levels: Iterable<string>): string[] {
  const unique = Array.from(new Set(Array.from(levels, (l) => l.trim().toLowerCase()).filter(Boolean)));
  return unique.sort((a, b) => {
    const ai = EFFORT_ORDER.indexOf(a as (typeof EFFORT_ORDER)[number]);
    const bi = EFFORT_ORDER.indexOf(b as (typeof EFFORT_ORDER)[number]);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
}

/**
 * Collapses effort-suffixed model variants (e.g. `gemini-4-neon-low`, `gemini-4-neon-high`)
 * into a single clean base model option (`Gemini 4 Neon`) with separated `reasoningLevels`,
 * while preserving non-suffixed models unchanged.
 */
export function collapseEffortVariantModels(
  rawModels: HarnessModelOption[]
): {
  models: HarnessModelOption[];
  variantMap: Map<string, Map<string, string>>; // baseId -> (effort -> concreteModelId)
} {
  const variantMap = new Map<string, Map<string, string>>();
  const grouped = new Map<string, HarnessModelOption>();
  const order: string[] = [];

  for (const m of rawModels) {
    const match = m.id.match(AGY_EFFORT_SUFFIX_RE);
    if (!match) {
      const cleanLabel = stripEffortFromLabel(m.label) || m.label;
      if (!grouped.has(m.id)) {
        order.push(m.id);
        grouped.set(m.id, { ...m, label: cleanLabel });
      }
      continue;
    }

    const baseId = match[1];
    const effort = match[2].toLowerCase();
    const cleanLabel = stripEffortFromLabel(m.label) || baseId;

    let byEffort = variantMap.get(baseId);
    if (!byEffort) {
      byEffort = new Map<string, string>();
      variantMap.set(baseId, byEffort);
    }
    byEffort.set(effort, m.id);

    const existing = grouped.get(baseId);
    if (!existing) {
      order.push(baseId);
      grouped.set(baseId, {
        ...m,
        id: baseId,
        label: cleanLabel,
        reasoningLevels: sortEffortLevels([...(m.reasoningLevels ?? []), effort]),
        defaultReasoningLevel: m.isDefault ? effort : m.defaultReasoningLevel || effort,
      });
    } else {
      const mergedLevels = sortEffortLevels([
        ...(existing.reasoningLevels ?? []),
        ...(m.reasoningLevels ?? []),
        effort,
      ]);
      grouped.set(baseId, {
        ...existing,
        isDefault: Boolean(existing.isDefault || m.isDefault),
        reasoningLevels: mergedLevels,
        defaultReasoningLevel: m.isDefault
          ? effort
          : existing.defaultReasoningLevel || m.defaultReasoningLevel,
      });
    }
  }

  return {
    models: order.map((id) => grouped.get(id)!),
    variantMap,
  };
}

export function formatEffortLabel(level: string): string {
  return EFFORT_META[level.toLowerCase()]?.label ?? level;
}

export function getEffortHint(level: string): string {
  return EFFORT_META[level.toLowerCase()]?.hint ?? '';
}

export interface ResolvedModelControls {
  /** Clean deduplicated base models (effort variants collapsed into `reasoningLevels`). */
  models: HarnessModelOption[];
  /** Uncollapsed catalog models (used to map baseId + effort back to concrete backend slugs). */
  rawModels: HarnessModelOption[];
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
  const suffixMatch = trimmedModel ? trimmedModel.match(AGY_EFFORT_SUFFIX_RE) : null;
  const normalizedBaseModelId = suffixMatch ? suffixMatch[1] : trimmedModel;

  const { models: collapsedCatalog } = collapseEffortVariantModels(catalogModels);
  const matchedInCollapsed = normalizedBaseModelId
    ? collapsedCatalog.find(
        (m) => m.id === normalizedBaseModelId || m.id === trimmedModel
      )
    : undefined;

  // If the session is running an observed model slug not listed in the catalog yet,
  // include it cleanly at the top so the dropdown always reflects reality.
  const models: HarnessModelOption[] =
    normalizedBaseModelId && !matchedInCollapsed
      ? [
          {
            id: normalizedBaseModelId,
            label: stripEffortFromLabel(normalizedBaseModelId),
            reasoningLevels:
              harnessGroup === 'codex'
                ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
                : harnessGroup === 'claude'
                  ? ['low', 'medium', 'high', 'xhigh', 'max']
                  : harnessGroup === 'muse'
                    ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
                    : suffixMatch
                      ? ['low', 'medium', 'high', 'xhigh']
                      : undefined,
          },
          ...collapsedCatalog,
        ]
      : collapsedCatalog;

  const defaultModelOption = models.find((m) => m.isDefault);
  const activeModelOption =
    matchedInCollapsed || (normalizedBaseModelId ? models[0] : defaultModelOption);
  const modelForThinking = activeModelOption || defaultModelOption || models[0];

  let thinkingLevels: string[];
  if (modelForThinking?.reasoningLevels && modelForThinking.reasoningLevels.length > 0) {
    thinkingLevels = modelForThinking.reasoningLevels;
  } else if (harnessGroup === 'codex') {
    thinkingLevels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  } else if (harnessGroup === 'claude') {
    thinkingLevels = ['low', 'medium', 'high', 'xhigh', 'max'];
  } else if (harnessGroup === 'muse') {
    thinkingLevels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  } else {
    thinkingLevels = !trimmedModel ? ['low', 'medium', 'high', 'xhigh'] : [];
  }

  const defaultEffort =
    harnessGroup === 'antigravity'
      ? modelForThinking?.defaultReasoningLevel || catalog?.defaultReasoningEffort?.antigravity
      : catalog?.defaultReasoningEffort?.[harnessGroup] ||
        modelForThinking?.defaultReasoningLevel;

  const activeEffort =
    (suffixMatch ? suffixMatch[2].toLowerCase() : undefined) ||
    currentEffort?.trim().toLowerCase() ||
    defaultEffort;

  const displayModelLabel =
    activeModelOption?.label ||
    (trimmedModel ? stripEffortFromLabel(trimmedModel) : undefined) ||
    defaultModelOption?.label ||
    fallbackHarnessLabel;

  return {
    models,
    rawModels: catalogModels,
    activeModelOption,
    displayModelLabel,
    thinkingLevels,
    activeEffort,
    defaultEffort,
  };
}

function resolveConcreteVariantId(
  baseOrExactId: string,
  desiredEffort: string | undefined,
  rawModels: HarnessModelOption[]
): { modelId: string; effort?: string } {
  const { variantMap, models } = collapseEffortVariantModels(rawModels);
  const baseMatch = baseOrExactId.match(AGY_EFFORT_SUFFIX_RE);
  const baseId = baseMatch ? baseMatch[1] : baseOrExactId;
  const byEffort = variantMap.get(baseId);
  if (!byEffort || byEffort.size === 0) {
    return { modelId: baseOrExactId, effort: desiredEffort };
  }

  const normalizedDesired = desiredEffort?.trim().toLowerCase();
  if (normalizedDesired && byEffort.has(normalizedDesired)) {
    return { modelId: byEffort.get(normalizedDesired)!, effort: normalizedDesired };
  }

  const collapsed = models.find((m) => m.id === baseId);
  const fallbackEffort =
    (collapsed?.defaultReasoningLevel && byEffort.has(collapsed.defaultReasoningLevel)
      ? collapsed.defaultReasoningLevel
      : undefined) ||
    (byEffort.has('medium') ? 'medium' : undefined) ||
    (byEffort.has('high') ? 'high' : undefined) ||
    Array.from(byEffort.keys())[0];

  return {
    modelId: byEffort.get(fallbackEffort) || baseOrExactId,
    effort: fallbackEffort,
  };
}

export function resolveModelSelectionChange(
  harnessGroup: HarnessGroup,
  nextModelId: string,
  currentEffort: string | undefined,
  models: HarnessModelOption[],
  rawModels?: HarnessModelOption[]
): { model: string; reasoningEffort?: string } {
  const lookupRaw = rawModels && rawModels.length > 0 ? rawModels : models;
  const picked = models.find((m) => m.id === nextModelId);
  const normalizedEffort = currentEffort?.trim().toLowerCase();

  // If this model family uses effort-suffixed backend slugs (e.g. Antigravity), resolve to concrete slug
  const resolvedVariant = resolveConcreteVariantId(nextModelId, normalizedEffort, lookupRaw);
  if (resolvedVariant.modelId !== nextModelId || harnessGroup === 'antigravity') {
    const suffixMatch = resolvedVariant.modelId.match(AGY_EFFORT_SUFFIX_RE);
    return {
      model: resolvedVariant.modelId,
      reasoningEffort: suffixMatch ? suffixMatch[2].toLowerCase() : resolvedVariant.effort || '',
    };
  }

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
  models: HarnessModelOption[],
  rawModels?: HarnessModelOption[]
): { model?: string; reasoningEffort: string } {
  const normalized = nextEffort.trim().toLowerCase();
  const lookupRaw = rawModels && rawModels.length > 0 ? rawModels : models;

  if (normalized) {
    const currentBase = currentModel?.match(AGY_EFFORT_SUFFIX_RE)?.[1] || currentModel;
    const active =
      models.find((m) => m.id === currentBase || m.id === currentModel) ||
      models.find((m) => m.isDefault) ||
      models[0];
    if (active) {
      const { variantMap } = collapseEffortVariantModels(lookupRaw);
      const byEffort = variantMap.get(active.id);
      const concrete = byEffort?.get(normalized);
      if (concrete) {
        return { model: concrete, reasoningEffort: normalized };
      }
      if (harnessGroup === 'antigravity') {
        const candidateId = `${active.id}-${normalized}`;
        if (lookupRaw.some((m) => m.id === candidateId)) {
          return { model: candidateId, reasoningEffort: normalized };
        }
      }
    }
  }
  return { reasoningEffort: normalized };
}
