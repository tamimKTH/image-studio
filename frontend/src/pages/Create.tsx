import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, ImagePlus, Mountain, Pencil, Scissors, Sparkles, Square, Sticker, Trash2, Type, X } from "lucide-react";
import {
  api,
  defaultAdvanced,
  defaultSettings,
  type Asset,
  type GenerateSettings,
  type OutputImage,
  type RunDetail,
} from "../lib/api";
import { useLive } from "../lib/events";
import { takeHandoff, useHandoff } from "../lib/handoff";
import { load, save } from "../lib/prefs";
import { ImageStrip, MAX_IMAGES, useImageDrop } from "../components/composer/ImageStrip";
import { OptionsBar } from "../components/composer/OptionsBar";
import { ImproveButton, PromptBox } from "../components/composer/PromptBox";
import { FolderPicker } from "../components/folders/FolderPicker";
import { CardAction } from "../components/media/ImageCard";
import { Lightbox, type LightboxItem } from "../components/media/Lightbox";
import {
  RunGroup,
  downloadFile,
  generateData,
  isActive,
  outputAsset,
  primeRun,
  runInputs,
  useRunDetails,
  useTrash,
  workNodeId,
} from "../components/media/RunResults";
import { Button, Chip, IconButton, toast } from "../components/ui";
import s from "./create.module.css";

interface CreatePrefs {
  settings: GenerateSettings;
  folder: string | null;
}

function loadPrefs(): CreatePrefs {
  const p = load<CreatePrefs>("create", { settings: defaultSettings, folder: null });
  const settings: GenerateSettings = {
    ...defaultSettings,
    ...p.settings,
    advanced: { ...defaultAdvanced, ...p.settings?.advanced },
  };
  settings.count = Math.min(4, Math.max(1, Math.round(settings.count) || 1));
  return { settings, folder: typeof p.folder === "string" ? p.folder : null };
}

const EXAMPLES: { icon: typeof Type; label: string; prompt: string; apply: (v: GenerateSettings) => GenerateSettings }[] = [
  {
    icon: Type,
    label: "Text in the picture",
    prompt: 'A cozy café chalkboard sign that says "Fresh Coffee · Open Late", warm morning light, photo',
    apply: (v) => ({ ...v, transparent: false }),
  },
  {
    icon: Sticker,
    label: "Transparent sticker",
    prompt: "A cute cartoon dragon sticker with a thick white outline",
    apply: (v) => ({ ...v, transparent: true, aspect: "1:1" }),
  },
  {
    icon: Mountain,
    label: "2K landscape",
    prompt: "A misty fjord at sunrise with a red wooden cabin by the water, cinematic landscape photo",
    apply: (v) => ({ ...v, transparent: false, size: "2k", aspect: "16:9" }),
  },
];

const RESULT_LIMIT = 24;
const errorToast = (e: unknown) => toast((e as Error).message, { tone: "error" });

export function Create() {
  const navigate = useNavigate();
  const initial = useMemo(loadPrefs, []);
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<Asset[]>([]);
  const [settings, setSettings] = useState<GenerateSettings>(initial.settings);
  const [folder, setFolder] = useState<string | null>(initial.folder);
  const [improving, setImproving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  useEffect(() => save("create", { settings, folder }), [settings, folder]);

  // Images (and a prompt) handed over from Library, Activity or a run.
  const handoffSeq = useHandoff((st) => st.seq);
  useEffect(() => {
    const handed = takeHandoff();
    if (handed.images.length) setImages(handed.images.slice(0, MAX_IMAGES));
    if (handed.prompt) setPrompt(handed.prompt);
  }, [handoffSeq]);

  const addImages = useCallback((assets: Asset[]) => {
    const next = [...imagesRef.current, ...assets];
    if (next.length > MAX_IMAGES) toast(`Up to ${MAX_IMAGES} images — the rest were left out`);
    setImages(next.slice(0, MAX_IMAGES));
  }, []);
  const drop = useImageDrop(addImages);

  const runsMap = useLive((st) => st.runs);
  const runs = useMemo(
    () =>
      Object.values(runsMap)
        .filter((r) => r.kind === "create")
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, RESULT_LIMIT),
    [runsMap],
  );
  const details = useRunDetails(runs);
  const { trashed, trash } = useTrash();

  const hasImages = images.length > 0;
  const canGenerate = prompt.trim().length > 0 && !improving;

  const generate = async () => {
    if (!canGenerate || submitting) return;
    setSubmitting(true);
    try {
      const { runId } = await api.create({ ...settings, prompt: prompt.trim(), images: images.map((i) => i.id), folder });
      await primeRun(runId);
    } catch (e) {
      errorToast(e);
    } finally {
      setSubmitting(false);
    }
  };
  const generateRef = useRef(generate);
  generateRef.current = generate;

  // ⌘↵ anywhere on the page (the prompt box handles it itself and marks the event handled).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      void generateRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  async function removeBackground() {
    const first = images[0];
    if (!first) return;
    try {
      const { runId } = await api.removeBackground(first.id, folder);
      await primeRun(runId);
      toast("Removing the background of image 1");
    } catch (e) {
      errorToast(e);
    }
  }

  async function addAsInput(output: OutputImage) {
    try {
      addImages([await outputAsset(output)]);
      toast("Added as an input image");
      top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      errorToast(e);
    }
  }

  async function editAgain(detail: RunDetail) {
    try {
      const inputs = await Promise.all(runInputs(detail).map(outputAsset));
      setImages(inputs.slice(0, MAX_IMAGES));
      const g = generateData(detail);
      if (g) {
        setPrompt(g.prompt);
        setSettings({
          aspect: g.aspect ?? defaultSettings.aspect,
          size: g.size ?? defaultSettings.size,
          quality: g.quality ?? defaultSettings.quality,
          count: g.count ?? defaultSettings.count,
          transparent: g.transparent ?? false,
          advanced: { ...defaultAdvanced, ...g.advanced },
        });
      }
      top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      errorToast(e);
    }
  }

  async function cancel(runId: string) {
    try {
      await api.cancelRun(runId);
      toast("Canceled");
    } catch (e) {
      errorToast(e);
    }
  }

  async function dismiss(runId: string) {
    try {
      await api.deleteRun(runId);
      useLive.setState((st) => {
        const rest = { ...st.runs };
        delete rest[runId];
        return { runs: rest };
      });
    } catch (e) {
      errorToast(e);
    }
  }

  // Every finished image on the page, in display order, for the lightbox.
  const entries = useMemo(
    () =>
      runs.flatMap((r) => {
        const d = details[r.id];
        const inputs = runInputs(d);
        const node = d?.nodes[workNodeId(d)];
        const outputs = node?.outputs?.length ? node.outputs : r.outputs;
        return outputs
          .filter((o) => !trashed.has(o.path))
          .map((o) => ({
            runId: r.id,
            output: o,
            item: { url: o.url, path: o.path, name: o.name, compareUrl: inputs.length === 1 ? inputs[0].url : null } as LightboxItem,
          }));
      }),
    [runs, details, trashed],
  );
  const openIndex = openPath ? entries.findIndex((e) => e.item.path === openPath) : -1;

  async function trashFromLightbox(index: number) {
    const entry = entries[index];
    const next = entries[index + 1] ?? entries[index - 1];
    if (entry && (await trash(entry.output.path))) setOpenPath(next && next !== entry ? next.item.path : null);
  }

  const cardActions = (o: OutputImage) => (
    <>
      <CardAction label="Use as input" onClick={() => addAsInput(o)}>
        <ImagePlus size={15} />
      </CardAction>
      <CardAction label="Download" onClick={() => downloadFile(o.url, o.name)}>
        <Download size={15} />
      </CardAction>
      <CardAction label="Move to Trash" onClick={() => trash(o.path)}>
        <Trash2 size={15} />
      </CardAction>
    </>
  );

  return (
    <div className={s.page} {...drop.handlers}>
      <div className={s.column} ref={top}>
        <h1 className={s.title}>What will you create?</h1>

        <div className={s.composer}>
          {(hasImages || drop.busy) && (
            <ImageStrip assets={images} onChange={setImages} uploading={drop.busy} onAddFiles={(files) => drop.accept(files)} />
          )}
          <PromptBox
            value={prompt}
            onChange={setPrompt}
            placeholder={hasImages ? "Describe the change — e.g. put image 2 on the table in image 1" : "Describe an image…"}
            onSubmit={generate}
            readOnly={improving}
            autoFocus
          />
          <div className={s.bar}>
            <div className={s.barLeft}>
              <IconButton label="Add images" onClick={() => fileInput.current?.click()}>
                <ImagePlus size={18} />
              </IconButton>
              <ImproveButton
                prompt={prompt}
                images={images.map((i) => i.id)}
                onChange={setPrompt}
                onAspect={(aspect) => setSettings((st) => ({ ...st, aspect }))}
                onBusyChange={setImproving}
              />
            </div>
            <div className={s.barRight}>
              <OptionsBar value={settings} onChange={setSettings} hasImages={hasImages} />
              <Button
                variant="primary"
                className={s.generate}
                icon={<Sparkles size={16} />}
                shortcut="⌘↵"
                onClick={generate}
                loading={submitting}
                disabled={!canGenerate}
              >
                Generate
              </Button>
            </div>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) void drop.accept(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        <div className={s.below}>
          <FolderPicker value={folder} onChange={setFolder} prefix="Saving to" />
          {hasImages && (
            <div className={s.suggestions}>
              <Chip icon={<Scissors size={15} />} onClick={removeBackground} title="Cut out the subject of image 1 as a transparent PNG">
                Remove background
              </Chip>
            </div>
          )}
        </div>

        {runs.length ? (
          <div className={s.results}>
            <div className={s.resultsHead}>
              <h2 className={s.sectionTitle}>Recent</h2>
              <button type="button" className={s.link} onClick={() => navigate("/activity")}>
                All activity
              </button>
            </div>
            {runs.map((r) => {
              const d = details[r.id];
              return (
                <RunGroup
                  key={r.id}
                  summary={r}
                  detail={d}
                  maxHeight={380}
                  trashed={trashed}
                  onOpen={(o) => setOpenPath(o.path)}
                  cardActions={cardActions}
                  headerActions={
                    isActive(r.status) ? (
                      <IconButton label="Cancel" onClick={() => cancel(r.id)}>
                        <Square size={15} />
                      </IconButton>
                    ) : (
                      <>
                        {d && (
                          <IconButton label="Edit again" onClick={() => editAgain(d)}>
                            <Pencil size={16} />
                          </IconButton>
                        )}
                        <IconButton label="Remove from the list (images stay in their folder)" onClick={() => dismiss(r.id)}>
                          <X size={16} />
                        </IconButton>
                      </>
                    )
                  }
                />
              );
            })}
          </div>
        ) : (
          <div className={s.welcome}>
            <div className={s.examples}>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  className={s.example}
                  onClick={() => {
                    setPrompt(ex.prompt);
                    setSettings((st) => ex.apply(st));
                  }}
                >
                  <span className={s.exampleLabel}>
                    <ex.icon size={14} />
                    {ex.label}
                  </span>
                  {ex.prompt}
                </button>
              ))}
            </div>
            <p className={s.welcomeText}>
              Tip: put words you want written in the picture in “double quotes”. Drop images anywhere to edit or combine them.
            </p>
          </div>
        )}
      </div>

      {drop.dragging && (
        <div className={s.dropOverlay}>
          <div className={s.dropMessage}>
            <ImagePlus size={26} />
            Drop images to add them
            <span>Up to {MAX_IMAGES} — they are numbered in order</span>
          </div>
        </div>
      )}

      <Lightbox
        items={entries.map((e) => e.item)}
        index={openIndex >= 0 ? openIndex : null}
        onIndex={(i) => setOpenPath(i === null ? null : entries[i]?.item.path ?? null)}
        actions={(item) => {
          const index = entries.findIndex((e) => e.item.path === item.path);
          const entry = entries[index];
          if (!entry) return null;
          const detail = details[entry.runId];
          return (
            <>
              <Button
                icon={<ImagePlus size={16} />}
                onClick={() => {
                  setOpenPath(null);
                  void addAsInput(entry.output);
                }}
              >
                Use as input
              </Button>
              {detail && (
                <Button
                  icon={<Pencil size={16} />}
                  onClick={() => {
                    setOpenPath(null);
                    void editAgain(detail);
                  }}
                >
                  Edit again
                </Button>
              )}
              <Button icon={<Trash2 size={16} />} onClick={() => trashFromLightbox(index)}>
                Move to Trash
              </Button>
            </>
          );
        }}
      />
    </div>
  );
}
