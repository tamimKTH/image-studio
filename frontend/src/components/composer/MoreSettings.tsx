import { useEffect, useState } from "react";
import { Dices } from "lucide-react";
import { api, defaultAdvanced, type Advanced, type GenerateSettings, type Options } from "../../lib/api";
import { Button, IconButton, Segmented, inputClass, selectClass, textareaClass } from "../ui";
import s from "./composer.module.css";

export const QUALITY_STEPS = { fast: 16, standard: 28, best: 40 } as const;

/** Steps a generation will use: the custom count if set, otherwise the quality preset's. */
export function effectiveSteps(v: Pick<GenerateSettings, "quality" | "advanced">): number {
  return v.advanced?.steps ?? QUALITY_STEPS[v.quality] ?? QUALITY_STEPS.standard;
}

// Used until the engine's own lists arrive (and if they can't be fetched).
const FALLBACK: Options = {
  samplers: ["euler", "euler_ancestral", "heun", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "res_multistep", "uni_pc"],
  schedulers: ["simple", "normal", "karras", "exponential", "sgm_uniform", "beta", "linear_quadratic"],
};

let optionsRequest: Promise<Options> | null = null;
let engineOptions: Options | null = null;

/** Fetches the engine's sampler and scheduler names once per page load (again later if it failed). */
export function prefetchOptions(): Promise<Options> {
  optionsRequest ??= api
    .options()
    .then((o) => (engineOptions = o.samplers?.length && o.schedulers?.length ? o : FALLBACK))
    .catch(() => {
      optionsRequest = null;
      return FALLBACK;
    });
  return optionsRequest;
}

function useEngineOptions(): Options {
  const [options, setOptions] = useState<Options>(engineOptions ?? FALLBACK);
  useEffect(() => {
    let alive = true;
    void prefetchOptions().then((o) => alive && setOptions(o));
    return () => {
      alive = false;
    };
  }, []);
  return options;
}

const WORDS: Record<string, string> = {
  dpmpp: "DPM++", dpm: "DPM", sde: "SDE", gpu: "GPU", cfg: "CFG", pp: "++", cfgpp: "CFG++", lcm: "LCM", lms: "LMS",
  ddim: "DDIM", ddpm: "DDPM", uni: "Uni", pc: "PC", bh2: "BH2", ipndm: "iPNDM", deis: "DEIS", er: "ER", sa: "SA",
  kl: "KL", sgm: "SGM", ays: "AYS", gits: "GITS", pece: "PECE", ud10: "UD10", ab: "AB", x0: "x0", heunpp2: "Heun++ 2",
};

/** "dpmpp_2m_sde" → "DPM++ 2M SDE", "euler_ancestral_cfg_pp" → "Euler ancestral CFG++". */
export function optionLabel(name: string): string {
  return name
    .split("_")
    .map((w, i) => WORDS[w] ?? (/^\d+[a-z]$/.test(w) ? w.toUpperCase() : i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
    .replace(" CFG ++", " CFG++");
}

/** The engine's list, plus the chosen value if it isn't in it (so a saved choice is never hidden). */
const withValue = (list: string[], value: string) => (list.includes(value) ? list : [value, ...list]);

/** True when anything under More differs from the defaults (shown as a dot on the button). */
export function hasAdvancedChanges(v: GenerateSettings): boolean {
  const a = v.advanced;
  return (
    v.quality !== "standard" ||
    a.seed !== null ||
    !!a.negative.trim() ||
    a.cfg !== null ||
    a.steps !== null ||
    a.sampler !== defaultAdvanced.sampler ||
    a.scheduler !== defaultAdvanced.scheduler ||
    a.refDetail !== defaultAdvanced.refDetail
  );
}

interface Props {
  value: GenerateSettings;
  onChange: (v: GenerateSettings) => void;
  hasImages: boolean;
}

/** Rarely needed settings. Every field has a working default. */
export function MoreSettings({ value, onChange, hasImages }: Props) {
  const a = value.advanced;
  const setA = (patch: Partial<Advanced>) => onChange({ ...value, advanced: { ...a, ...patch } });
  const autoCfg = a.negative.trim() ? 4 : 1;
  const options = useEngineOptions();

  return (
    <div className={s.more}>
      <div className={s.moreRow}>
        <div className={s.moreLabel}>
          Quality{" "}
          <span className={s.moreHint}>
            {a.steps !== null ? `${a.steps} steps (custom)` : `${QUALITY_STEPS[value.quality]} steps`}
          </span>
        </div>
        <Segmented
          label="Quality"
          value={value.quality}
          onChange={(quality) => onChange({ ...value, quality })}
          options={[
            { value: "fast", label: "Fast" },
            { value: "standard", label: "Standard" },
            { value: "best", label: "Best", title: "The official pipeline's 40 steps" },
          ]}
        />
      </div>

      <div className={s.moreRow}>
        <div className={s.moreLabel}>
          Seed <span className={s.moreHint}>{a.seed === null ? "New every time" : "Same result for the same prompt"}</span>
        </div>
        <div className={s.inline}>
          <Segmented
            label="Seed"
            value={a.seed === null ? "random" : "fixed"}
            onChange={(m) => setA({ seed: m === "random" ? null : Math.floor(Math.random() * 2 ** 31) })}
            options={[
              { value: "random", label: "Random" },
              { value: "fixed", label: "Fixed" },
            ]}
          />
          {a.seed !== null && (
            <>
              <input
                className={inputClass}
                type="number"
                min={0}
                value={a.seed}
                onChange={(e) => setA({ seed: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                aria-label="Seed"
              />
              <IconButton label="New seed" onClick={() => setA({ seed: Math.floor(Math.random() * 2 ** 31) })}>
                <Dices size={17} />
              </IconButton>
            </>
          )}
        </div>
      </div>

      <div className={s.moreRow}>
        <div className={s.moreLabel}>
          Avoid <span className={s.moreHint}>Negative prompt · about 2× slower</span>
        </div>
        <textarea
          className={textareaClass}
          rows={2}
          placeholder="e.g. blurry, extra fingers, watermark"
          value={a.negative}
          onChange={(e) => setA({ negative: e.target.value })}
        />
      </div>

      <div className={s.moreRow}>
        <div className={s.moreLabel}>
          Guidance <span className={s.moreHint}>{a.cfg === null ? `Auto (${autoCfg})` : "How strictly to follow the prompt"}</span>
        </div>
        <div className={s.inline}>
          <input
            className={s.slider}
            type="range"
            min={1}
            max={8}
            step={0.5}
            value={a.cfg ?? autoCfg}
            onChange={(e) => setA({ cfg: Number(e.target.value) })}
            aria-label="Guidance"
          />
          <span className={s.value}>{(a.cfg ?? autoCfg).toFixed(1)}</span>
        </div>
      </div>

      <div className={s.moreRow}>
        <div className={s.moreLabel}>
          Steps{" "}
          <span className={s.moreHint}>{a.steps === null ? `Auto: ${QUALITY_STEPS[value.quality]}, from Quality` : "Custom — clear to use Quality"}</span>
        </div>
        <input
          className={inputClass}
          type="number"
          min={1}
          max={100}
          placeholder={`Auto (${QUALITY_STEPS[value.quality]})`}
          value={a.steps ?? ""}
          onChange={(e) => setA({ steps: e.target.value ? Math.min(100, Math.max(1, Math.floor(Number(e.target.value)))) : null })}
          aria-label="Steps"
        />
      </div>

      <div className={s.moreRow}>
        <div className={s.moreLabel}>Sampler and scheduler</div>
        <div className={s.inline}>
          <select className={selectClass} value={a.sampler} onChange={(e) => setA({ sampler: e.target.value })} aria-label="Sampler">
            {withValue(options.samplers, a.sampler).map((x) => (
              <option key={x} value={x}>
                {optionLabel(x)}
              </option>
            ))}
          </select>
          <select className={selectClass} value={a.scheduler} onChange={(e) => setA({ scheduler: e.target.value })} aria-label="Scheduler">
            {withValue(options.schedulers, a.scheduler).map((x) => (
              <option key={x} value={x}>
                {optionLabel(x)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {hasImages && (
        <div className={s.moreRow}>
          <div className={s.moreLabel}>
            Reference detail <span className={s.moreHint}>How much detail the model reads from the input images</span>
          </div>
          <Segmented
            label="Reference detail"
            value={a.refDetail}
            onChange={(refDetail) => setA({ refDetail })}
            options={[
              { value: "standard", label: "Standard" },
              { value: "high", label: "High (2K)" },
              { value: "original", label: "Original size" },
            ]}
          />
        </div>
      )}

      {hasAdvancedChanges(value) && (
        <Button
          size="sm"
          variant="ghost"
          className={s.reset}
          onClick={() => onChange({ ...value, quality: "standard", advanced: defaultAdvanced })}
        >
          Reset to defaults
        </Button>
      )}
    </div>
  );
}
