import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { fileName } from "../../lib/paths";
import type { BatchItemStatus } from "../../types/audio";

export function BatchStatusList({ items }: { items: BatchItemStatus[] }) {
  return (
    <div className="batch-status-list">
      {items.map((item) => (
        <div className={`batch-status-row is-${item.status}`} key={item.input}>
          {item.status === "done" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          <span>{fileName(item.input)}</span>
          <small>{item.status === "done" ? "Done" : item.message ?? "Failed"}</small>
        </div>
      ))}
    </div>
  );
}
