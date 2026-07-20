// TableView — Supabase-style table viewer: schema + data rows.

import { useState, useEffect, useCallback } from "react";
import * as api from "../lib/api";
import styles from "./TableView.module.css";

interface Column {
  name: string;
  type: string;
  pk: number;
}

interface TableViewProps {
  tableName: string;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function TableView({ tableName }: TableViewProps) {
  const [columns, setColumns] = useState<Column[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState(0);

  const fetchData = useCallback(async () => {
    try {
      const [schema, dataResult, countResult] = await Promise.all([
        api.inspectDataSchema(),
        api.query(`SELECT * FROM ${quoteIdentifier(tableName)} LIMIT 100`),
        api.query(`SELECT COUNT(*) as count FROM ${quoteIdentifier(tableName)}`),
      ]);
      const table = schema.tables.find((candidate) => candidate.name === tableName);
      if (!table) throw new Error(`Unknown table: ${tableName}`);
      setColumns(
        table.columns.map((r) => ({
          name: r.name,
          type: r.type || "TEXT",
          pk: r.pk,
        })),
      );
      setRows(dataResult.rows as Record<string, unknown>[]);
      setRowCount((countResult.rows[0] as { count: number })?.count ?? 0);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }, [tableName]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return <div className={styles.center}>Loading...</div>;
  }

  if (error) {
    return <div className={styles.center} style={{ color: "#a8071a" }}>Error: {error}</div>;
  }

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <span className={styles.tableName}>{tableName}</span>
        <span className={styles.meta}>{rowCount} rows &middot; {columns.length} columns</span>
        <button className={styles.refreshBtn} onClick={fetchData} title="Refresh">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.451 5.609l-.579-.939-1.068.812-.076.094c.335.57.527 1.225.527 1.924a4.008 4.008 0 0 1-4.5 3.969l.008-.047L6.3 13.499l.093.009A5.993 5.993 0 0 0 14.255 7.5a5.965 5.965 0 0 0-.804-1.891zM8 2.5a5.981 5.981 0 0 0-4.255 1.778l-.451-.312.579.939.804 1.891 1.068-.812.076-.094A4.007 4.007 0 0 1 10.5 4.031l-.008.047L11.7 2.501l-.093-.009A5.961 5.961 0 0 0 8 2.5z" />
          </svg>
        </button>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.name}>
                  <span className={styles.colHeader}>
                    {col.name}
                    <span className={styles.colTypeBadge}>{col.type}</span>
                    {col.pk ? <span className={styles.pkBadge}>PK</span> : null}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className={styles.emptyRow}>
                  No rows
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={i}>
                  {columns.map((col) => (
                    <td key={col.name}>
                      {row[col.name] === null ? (
                        <span className={styles.nullValue}>NULL</span>
                      ) : typeof row[col.name] === "object" ? (
                        JSON.stringify(row[col.name])
                      ) : (
                        String(row[col.name])
                      )}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {rowCount > 100 && (
        <div className={styles.footer}>Showing first 100 of {rowCount} rows</div>
      )}
    </div>
  );
}
