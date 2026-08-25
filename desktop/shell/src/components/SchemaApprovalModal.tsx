import { useState } from "react";
import type { SchemaRequest } from "../lib/api";
import styles from "./SchemaApprovalModal.module.css";

interface SchemaApprovalModalProps {
  request: SchemaRequest;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
}

export function SchemaApprovalModal({
  request,
  onApprove,
  onReject,
}: SchemaApprovalModalProps) {
  const [busy, setBusy] = useState(false);
  const diff = describeSchemaChange(request);

  async function submit(kind: "approve" | "reject") {
    setBusy(true);
    try {
      if (kind === "approve") {
        await onApprove(request.id);
      } else {
        await onReject(request.id);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.backdrop}>
      <div className={styles.modal} role="dialog" aria-modal="true">
        <div className={styles.header}>
          <div className={styles.title}>Schema change</div>
          <div className={styles.meta}>
            {request.author === undefined ? null : `${request.author} · `}
            {new Date(request.createdAt).toLocaleString()}
          </div>
        </div>
        <div className={styles.body}>
          {request.context === undefined ? null : (
            <section className={styles.section}>
              <div className={styles.label}>Context</div>
              <p className={styles.context}>{request.context}</p>
            </section>
          )}
          <section className={styles.section}>
            <div className={styles.label}>Schema diff</div>
            {diff.changes.length === 0 ? (
              <div className={styles.empty}>No before/after schema difference.</div>
            ) : (
              <ul className={styles.changeList}>
                {diff.changes.map((change) => <li key={change}>{change}</li>)}
              </ul>
            )}
          </section>
          {diff.destructive.length === 0 ? null : (
            <section className={`${styles.section} ${styles.destructive}`}>
              <div className={styles.label}>Destructive effects</div>
              <ul className={styles.changeList}>
                {diff.destructive.map((effect) => <li key={effect}>{effect}</li>)}
              </ul>
            </section>
          )}
          <div className={styles.label}>Exact DDL</div>
          <pre className={styles.ddl}>{request.ddl.join("\n\n")}</pre>
        </div>
        <div className={styles.footer}>
          <div className={styles.footerSpacer} />
          <button className={styles.button} disabled={busy} onClick={() => submit("reject")}>
            Reject
          </button>
          <button
            className={`${styles.button} ${styles.primary}`}
            disabled={busy}
            onClick={() => submit("approve")}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}

function describeSchemaChange(request: SchemaRequest): {
  changes: string[];
  destructive: string[];
} {
  const changes: string[] = [];
  const destructive = new Set<string>();
  const beforeTables = new Map(request.beforeSchema.tables.map((table) => [table.name, table]));
  const afterTables = new Map(request.afterSchema.tables.map((table) => [table.name, table]));

  for (const [name, table] of afterTables) {
    const before = beforeTables.get(name);
    if (!before) {
      changes.push(`+ Table ${name}`);
      continue;
    }
    const beforeColumns = new Map(before.columns.map((column) => [column.name, column]));
    const afterColumns = new Map(table.columns.map((column) => [column.name, column]));
    let columnChange = false;
    for (const [columnName, column] of afterColumns) {
      const previous = beforeColumns.get(columnName);
      if (!previous) {
        changes.push(`+ Column ${name}.${columnName}`);
        columnChange = true;
      } else if (JSON.stringify(previous) !== JSON.stringify(column)) {
        changes.push(`~ Column ${name}.${columnName}`);
        destructive.add(`Changes the definition of column ${name}.${columnName}.`);
        columnChange = true;
      }
    }
    for (const columnName of beforeColumns.keys()) {
      if (!afterColumns.has(columnName)) {
        changes.push(`− Column ${name}.${columnName}`);
        destructive.add(`Removes column ${name}.${columnName} and its values.`);
        columnChange = true;
      }
    }
    if (!columnChange && before.sql !== table.sql) changes.push(`~ Table ${name} definition`);
  }
  for (const name of beforeTables.keys()) {
    if (!afterTables.has(name)) {
      changes.push(`− Table ${name}`);
      destructive.add(`Drops table ${name} and all of its rows.`);
    }
  }

  const beforeIndexes = new Map(request.beforeSchema.indexes.map((index) => [index.name, index]));
  const afterIndexes = new Map(request.afterSchema.indexes.map((index) => [index.name, index]));
  for (const [name, index] of afterIndexes) {
    const before = beforeIndexes.get(name);
    if (!before) changes.push(`+ Index ${name} on ${index.table}`);
    else if (JSON.stringify(before) !== JSON.stringify(index)) changes.push(`~ Index ${name}`);
  }
  for (const name of beforeIndexes.keys()) {
    if (!afterIndexes.has(name)) {
      changes.push(`− Index ${name}`);
      destructive.add(`Removes index ${name}.`);
    }
  }

  for (const ddl of request.ddl) {
    const droppedTable = droppedObjectName(ddl, "TABLE");
    if (droppedTable && beforeTables.has(droppedTable)) {
      destructive.add(`Drops table ${droppedTable} and all of its rows.`);
    }
    const droppedIndex = droppedObjectName(ddl, "INDEX");
    if (droppedIndex && beforeIndexes.has(droppedIndex)) {
      destructive.add(`Removes index ${droppedIndex}.`);
    }
  }
  return { changes, destructive: [...destructive] };
}

function droppedObjectName(ddl: string, type: "TABLE" | "INDEX"): string | undefined {
  const identifier = '("(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_]*)';
  const match = ddl.match(new RegExp(`^\\s*DROP\\s+${type}\\s+(?:IF\\s+EXISTS\\s+)?${identifier}\\s*$`, "i"));
  if (!match) return undefined;
  const value = match[1];
  if (value.startsWith('"')) return value.slice(1, -1).replace(/""/g, '"');
  if (value.startsWith("`")) return value.slice(1, -1).replace(/``/g, "`");
  if (value.startsWith("[")) return value.slice(1, -1);
  return value;
}
