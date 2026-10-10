import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SOCKET_EVENTS } from '@oblihub/shared';
import { useSocket } from '@/hooks/useSocket';
import '@xterm/xterm/css/xterm.css';

interface Props {
  dockerId: string;
  onClose: () => void;
}

export function ContainerConsole({ dockerId, onClose }: Props) {
  const socket = useSocket();
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, Monaco, monospace',
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#0d1117',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#c9d1d9',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    // Start exec session
    const { cols, rows } = term;
    socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_START, { dockerId, cols, rows });

    // Receive output from container
    const onOutput = (payload: { dockerId: string; data: string }) => {
      if (payload.dockerId !== dockerId) return;
      term.write(payload.data);
    };

    const onError = (payload: { dockerId: string; error: string }) => {
      if (payload.dockerId !== dockerId) return;
      term.write(`\r\n\x1b[31m[${payload.error}]\x1b[0m\r\n`);
    };

    socket.on(SOCKET_EVENTS.CONTAINER_EXEC_OUTPUT, onOutput);
    socket.on(SOCKET_EVENTS.CONTAINER_EXEC_ERROR, onError);

    // Send input to container (keyboard typing)
    const inputDisposable = term.onData((data) => {
      socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_INPUT, { dockerId, data });
    });

    // Handle paste via CTRL+V / right-click — xterm onData already handles this
    // when allowProposedApi is true, but we also handle the browser paste event
    // to ensure clipboard paste always works
    const handlePaste = (e: ClipboardEvent) => {
      // Only intercept if terminal is focused
      if (!terminalRef.current?.contains(document.activeElement) &&
          !terminalRef.current?.contains(e.target as Node)) return;
      const text = e.clipboardData?.getData('text');
      if (text) {
        e.preventDefault();
        socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_INPUT, { dockerId, data: text });
      }
    };
    document.addEventListener('paste', handlePaste);

    // Handle resize
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_RESIZE, { dockerId, cols, rows });
    });

    // Fit on window resize
    const handleWindowResize = () => fitAddon.fit();
    window.addEventListener('resize', handleWindowResize);

    // Also fit after a short delay to handle layout settling
    const fitTimer = setTimeout(() => fitAddon.fit(), 100);

    return () => {
      clearTimeout(fitTimer);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      socket.off(SOCKET_EVENTS.CONTAINER_EXEC_OUTPUT, onOutput);
      socket.off(SOCKET_EVENTS.CONTAINER_EXEC_ERROR, onError);
      socket.emit(SOCKET_EVENTS.CONTAINER_EXEC_STOP, { dockerId });
      document.removeEventListener('paste', handlePaste);
      window.removeEventListener('resize', handleWindowResize);
      term.dispose();
    };
  }, [dockerId, socket]);

  return (
    <div className="rounded-lg border border-border bg-bg-tertiary overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-bg-secondary border-b border-border">
        <span className="text-xs font-medium text-text-secondary">Console</span>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-bg-hover text-text-muted text-xs"
          title="Close"
        >
          &times;
        </button>
      </div>
      <div ref={terminalRef} className="h-72" />
    </div>
  );
}
