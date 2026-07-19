import * as React from "react";
import { system } from "@lamarck/system";

export default function HelloWorldApp() {
  const [rows, setRows] = React.useState<unknown[]>([]);

  async function refresh() {
    const result = await system.query("SELECT id, created_at FROM docs ORDER BY updated_at DESC LIMIT 5");
    setRows(result.rows);
  }

  React.useEffect(() => {
    refresh();
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Hello World</h1>
      <button onClick={refresh}>Refresh docs</button>
      <pre style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{JSON.stringify(rows, null, 2)}</pre>
    </main>
  );
}

export function HelloWorld({ name = "World" }: { name?: string }) {
  return (
    <div style={{ padding: "1rem", border: "1px solid #ccc", borderRadius: "8px" }}>
      <h3>Hello, {name}!</h3>
      <p>This component is rendered from the hello-world app.</p>
    </div>
  );
}
