import { Copy, Image as ImageIcon, SlidersHorizontal } from "lucide-react";
import type { Aspect, GenerateSettings } from "../../lib/api";
import { Chip, IconButton, Popover, Segmented, cx, usePopover } from "../ui";
import { MoreSettings, hasAdvancedChanges } from "./MoreSettings";
import s from "./composer.module.css";

export const ASPECTS: { value: Exclude<Aspect, "auto">; label: string; w: number; h: number }[] = [
  { value: "1:1", label: "Square", w: 1, h: 1 },
  { value: "4:3", label: "4:3", w: 4, h: 3 },
  { value: "3:4", label: "3:4", w: 3, h: 4 },
  { value: "3:2", label: "3:2", w: 3, h: 2 },
  { value: "2:3", label: "2:3", w: 2, h: 3 },
  { value: "16:9", label: "Wide", w: 16, h: 9 },
  { value: "9:16", label: "Tall", w: 9, h: 16 },
];

function Shape({ w, h, size = 26 }: { w: number; h: number; size?: number }) {
  const scale = size / Math.max(w, h);
  const box = size + (size < 20 ? 2 : 10);
  return (
    <span className={s.ratioShape} style={{ width: box, height: box }}>
      <span style={{ width: w * scale, height: h * scale }} />
    </span>
  );
}

interface Props {
  value: GenerateSettings;
  onChange: (v: GenerateSettings) => void;
  /** Whether input images are attached (enables "Match image 1" and reference detail). */
  hasImages: boolean;
}

/** The few generation choices, as chips with their current value visible. */
export function OptionsBar({ value, onChange, hasImages }: Props) {
  const aspect = usePopover();
  const count = usePopover();
  const more = usePopover<HTMLButtonElement>();
  const set = (patch: Partial<GenerateSettings>) => onChange({ ...value, ...patch });

  const effective = value.aspect === "auto" && !hasImages ? "1:1" : value.aspect;
  const aspectLabel = effective === "auto" ? "Match image 1" : effective;
  const shape = ASPECTS.find((a) => a.value === effective);

  return (
    <div className={s.options}>
      <Chip
        ref={aspect.anchor}
        onClick={aspect.toggle}
        title="Aspect ratio"
        icon={effective === "auto" ? <ImageIcon size={15} /> : shape ? <Shape w={shape.w} h={shape.h} size={14} /> : null}
      >
        {aspectLabel}
      </Chip>
      <Popover anchor={aspect.anchor} open={aspect.open} onClose={aspect.close} title="Aspect ratio" width={300}>
        <div className={s.ratioGrid}>
          {hasImages && (
            <button
              type="button"
              className={cx(s.ratio, s.ratioWide, value.aspect === "auto" && s.on)}
              onClick={() => (set({ aspect: "auto" }), aspect.close())}
            >
              <ImageIcon size={16} /> Match image 1
            </button>
          )}
          {ASPECTS.map((a) => (
            <button
              key={a.value}
              type="button"
              className={cx(s.ratio, effective === a.value && s.on)}
              onClick={() => (set({ aspect: a.value }), aspect.close())}
            >
              <Shape w={a.w} h={a.h} />
              {a.label === a.value ? a.value : `${a.label} ${a.value}`}
            </button>
          ))}
        </div>
      </Popover>

      <Segmented
        label="Size"
        value={value.size}
        onChange={(size) => set({ size })}
        options={[
          { value: "1k", label: "1K", title: "About 1 megapixel — fast" },
          { value: "2k", label: "2K", title: "Native 2K (about 4 megapixels) — about 4× slower" },
        ]}
      />

      <Chip ref={count.anchor} onClick={count.toggle} title="How many variations" icon={<Copy size={14} />}>
        ×{value.count}
      </Chip>
      <Popover anchor={count.anchor} open={count.open} onClose={count.close} title="Variations">
        <div className={s.countRow}>
          {[1, 2, 3, 4].map((n) => (
            <button
              key={n}
              type="button"
              className={cx(s.countButton, value.count === n && s.on)}
              onClick={() => (set({ count: n }), count.close())}
            >
              {n}
            </button>
          ))}
        </div>
      </Popover>

      <Chip
        selected={value.transparent}
        onClick={() => set({ transparent: !value.transparent })}
        title="Transparent background (PNG with alpha)"
        icon={<span className={s.transparentIcon} />}
        aria-pressed={value.transparent}
      >
        Transparent
      </Chip>

      <IconButton
        ref={more.anchor}
        label="More settings"
        active={more.open}
        className={cx(hasAdvancedChanges(value) && s.moreDot)}
        onClick={more.toggle}
      >
        <SlidersHorizontal size={17} />
      </IconButton>
      <Popover anchor={more.anchor} open={more.open} onClose={more.close} title="More settings" width={340} placement="bottom-end">
        <MoreSettings value={value} onChange={onChange} hasImages={hasImages} />
      </Popover>
    </div>
  );
}
