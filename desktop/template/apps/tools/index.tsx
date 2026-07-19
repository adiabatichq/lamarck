import * as React from "react";

export default function ToolsApp() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Tools</h1>
      <p>Small local tools can live here.</p>
    </main>
  );
}

export function Counter() {
  const [count, setCount] = React.useState(0);
  return <button onClick={() => setCount((value) => value + 1)}>Count {count}</button>;
}

export function Calc() {
  return <div>Calc</div>;
}

export function Clock() {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return <time>{now.toLocaleTimeString()}</time>;
}
