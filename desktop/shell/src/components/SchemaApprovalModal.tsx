import { useState } from "react";
import type { SchemaRequest } from "../lib/api";
import styles from "./SchemaApprovalModal.module.css";

interface SchemaApprovalModalProps {
  request: SchemaRequest;
  onApprove: (id: string, remember: boolean) => Promise<void>;
  onReject: (id: string) => Promise<void>;
}

export function SchemaApprovalModal({
  request,
  onApprove,
  onReject,
}: SchemaApprovalModalProps) {
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(kind: "approve" | "reject") {
    setBusy(true);
    try {
      if (kind === "approve") {
        await onApprove(request.id, remember);
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
          <div className={styles.title}>Schema {request.kind}</div>
          <div className={styles.meta}>
            {request.requestedBy} · {new Date(request.createdAt).toLocaleString()}
          </div>
        </div>
        <div className={styles.body}>
          <pre className={styles.ddl}>{request.ddl.join(";\n\n")}</pre>
        </div>
        <div className={styles.footer}>
          <label className={styles.remember}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.currentTarget.checked)}
            />
            Let coding agent decide next time
          </label>
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
