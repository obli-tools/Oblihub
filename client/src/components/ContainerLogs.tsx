import { useEffect, useRef, useState, useCallback } from 'react';
import { Pause, Play, Trash2, ArrowDown } from 'lucide-react';
import { SOCKET_EVENTS } from '@oblihub/shared';
import { useSocket } from '@/hooks/useSocket';

interface Props {
  dockerId: string;
  onClose: () => void;
}

const MAX_LINES = 2000;

export function ContainerLogs({ dockerId, onClose }: Props) {
  const socket = useSocket();
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const bufferRef = useRef<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    pausedRef.current = paused;
    if (!paused && bufferRef.current.length > 0) {
      setLines(prev => {
        const merged = [...prev, ...bufferRef.current];
        return merged.slice(-MAX_LINES);
      });
      bufferRef.current = [];
    }
  }, [paused]);

  useEffect(() => {
    socket.emit(SOCKET_EVENTS.CONTAINER_LOGS_SUBSCRIBE, { dockerId, tail: 200 });

    const onData = (payload: { dockerId: string; data: string }) => {
      if (payload.dockerId !== dockerId) return;
      const newLines = payload.data.split('\n').filter(Boolean);
      if (pausedRef.current) {
        bufferRef.current.push(...newLines);
      } else {
        setLines(prev => {
          const merged = [...prev, ...newLines];
          return merged.slice(-MAX_LINES);
        });
      }
    };

    socket.on(SOCKET_EVENTS.CONTAINER_LOGS_DATA, onData);

    return () => {
      socket.off(SOCKET_EVENTS.CONTAINER_LOGS_DATA, onData);
      socket.emit(SOCKET_EVENTS.CONTAINER_LOGS_UNSUBSCRIBE, { dockerId });
    };
  }, [dockerId, socket]);

  useEffect(() => {
    if (autoScroll && !paused && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines, autoScroll, paused]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }, []);

  return (
    <div className="rounded-lg border border-border bg-bg-tertiary overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-bg-secondary border-b border-border">
        <span className="text-xs font-medium text-text-secondary">Logs</span>
        <div className="flex items-center gap-1">
          {paused && bufferRef.current.length > 0 && (
            <span className="text-[10px] text-status-pending mr-1">{bufferRef.current.length} buffered</span>
          )}
          <button
            onClick={() => setPaused(p => !p)}
            className={`p-1 rounded hover:bg-bg-hover ${paused ? 'text-status-pending' : 'text-text-muted'}`}
            title={paused ? 'Resume' : 'Pause'}
          >
            {paused ? <Play size={12} /> : <Pause size={12} />}
          </button>
          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
              }}
              className="p-1 rounded hover:bg-bg-hover text-text-muted"
              title="Scroll to bottom"
            >
              <ArrowDown size={12} />
            </button>
          )}
          <button
            onClick={() => setLines([])}
            className="p-1 rounded hover:bg-bg-hover text-text-muted"
            title="Clear"
          >
            <Trash2 size={12} />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-bg-hover text-text-muted text-xs"
            title="Close"
          >
            &times;
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="overflow-auto font-mono text-[11px] leading-relaxed p-2 max-h-72 text-text-primary bg-[#0d1117] select-text"
      >
        {lines.length === 0 ? (
          <div className="text-text-muted text-center py-4">Waiting for logs...</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all hover:bg-white/5">{line}</div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
