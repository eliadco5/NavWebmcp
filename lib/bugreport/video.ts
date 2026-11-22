// Optional real screen video of a scenario: getDisplayMedia (the browser asks
// the user to share this tab) + MediaRecorder → WebM. Low frame rate and
// bitrate keep 90 s under the 4 MB attachment limit.

export const MAX_VIDEO_MS = 90_000;
const BITRATE = 300_000;

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let stream: MediaStream | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function videoSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== "undefined";
}

/** Resolves to null on success, or a human-readable reason it isn't recording. */
export async function startVideo(): Promise<string | null> {
  if (!videoSupported()) return "This browser can't record the screen.";
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 10 },
      audio: false,
      // Chrome hints: offer this tab first.
      preferCurrentTab: true,
      selfBrowserSurface: "include",
    } as DisplayMediaStreamOptions);
  } catch (err) {
    const name = (err as DOMException)?.name;
    return name === "NotAllowedError" ? "Screen video was declined." : `Screen video unavailable (${name ?? "error"}).`;
  }
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) { stopTracks(); return "This browser can't encode WebM video."; }
  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: BITRATE });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.start(1000);
  timer = setTimeout(() => { if (recorder?.state === "recording") recorder.stop(); }, MAX_VIDEO_MS);
  // User pressed the browser's own "Stop sharing".
  stream.getVideoTracks()[0]?.addEventListener("ended", () => { if (recorder?.state === "recording") recorder.stop(); });
  return null;
}

function stopTracks() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

export async function stopVideo(): Promise<Blob | null> {
  if (timer) { clearTimeout(timer); timer = null; }
  const rec = recorder;
  recorder = null;
  if (!rec) { stopTracks(); return null; }
  if (rec.state === "recording") {
    await new Promise<void>((resolve) => { rec.onstop = () => resolve(); rec.stop(); });
  }
  stopTracks();
  const blob = chunks.length ? new Blob(chunks, { type: "video/webm" }) : null;
  chunks = [];
  return blob;
}

export function isVideoRecording(): boolean {
  return recorder?.state === "recording";
}
