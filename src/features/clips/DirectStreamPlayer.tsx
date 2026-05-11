import React from "react";
import { AlertTriangle } from "lucide-react";

export function DirectStreamPlayer({ src }: { src: string }) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [playbackError, setPlaybackError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    let hls: { destroy: () => void } | null = null;
    let cancelled = false;
    const isHlsStream = /\.m3u8($|[?#])/i.test(src);
    setPlaybackError(null);
    video.pause();
    video.removeAttribute("src");
    video.load();

    if (isHlsStream) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
      } else {
        void import("hls.js")
          .then(({ default: Hls }) => {
            if (cancelled || !videoRef.current) return;
            if (!Hls.isSupported()) {
              setPlaybackError("This WebView does not support HLS playback.");
              return;
            }
            const instance = new Hls({
              enableWorker: true,
              lowLatencyMode: false,
            });
            hls = instance;
            instance.on(Hls.Events.ERROR, (_event, data) => {
              if (data.fatal) {
                setPlaybackError(`${data.type}: ${data.details}`);
              }
            });
            instance.loadSource(src);
            instance.attachMedia(video);
          })
          .catch((error) => {
            setPlaybackError(error instanceof Error ? error.message : String(error));
          });
      }
    } else {
      video.src = src;
    }

    return () => {
      cancelled = true;
      hls?.destroy();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);

  return (
    <div className="direct-stream-player">
      <video
        ref={videoRef}
        controls
        autoPlay
        crossOrigin="anonymous"
        onError={() => setPlaybackError("The stream could not be played by the WebView player.")}
      />
      {playbackError && (
        <div className="direct-stream-error">
          <AlertTriangle size={16} />
          <span>{playbackError}</span>
        </div>
      )}
    </div>
  );
}
