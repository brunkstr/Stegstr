import React from "react";

type State = { hasError: boolean; error?: Error; componentStack?: string };

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[Stegstr] ErrorBoundary caught", error, info);
    this.setState({ componentStack: info.componentStack ?? undefined });
  }

  render() {
    if (this.state.hasError && this.state.error) {
      const err = this.state.error;
      const message = err.message || String(err);
      const stack = err.stack || "";
      const componentStack = this.state.componentStack || "";
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "flex-start",
            padding: "2rem",
            fontFamily: "Helvetica, Arial, sans-serif",
            background: "#f5f5f5",
            color: "#111",
          }}
        >
          <h1 style={{ marginBottom: "0.5rem", fontSize: "1.25rem" }}>
            Something went wrong
          </h1>
          <p style={{ marginBottom: "1rem", color: "#666", fontSize: "0.9rem" }}>
            The app hit an error. Reload to start fresh.
          </p>
          <div
            style={{
              width: "100%",
              maxWidth: "600px",
              marginBottom: "1rem",
              padding: "1rem",
              background: "#fff",
              border: "1px solid #ddd",
              borderRadius: "8px",
              fontSize: "0.8rem",
              overflow: "auto",
              maxHeight: "40vh",
              textAlign: "left",
            }}
          >
            <div style={{ marginBottom: "0.5rem", fontWeight: 600 }}>Error</div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {message}
            </pre>
            {stack && (
              <>
                <div style={{ marginTop: "0.75rem", marginBottom: "0.25rem", fontWeight: 600 }}>
                  Stack
                </div>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.75rem" }}>
                  {stack}
                </pre>
              </>
            )}
            {componentStack && (
              <>
                <div style={{ marginTop: "0.75rem", marginBottom: "0.25rem", fontWeight: 600 }}>
                  Component stack
                </div>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.75rem" }}>
                  {componentStack}
                </pre>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "0.5rem 1rem",
              fontSize: "1rem",
              background: "#111",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
