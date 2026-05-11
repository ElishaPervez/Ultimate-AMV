import type { NavItem } from "../types/app";

export function SidebarButton({
  item,
  active,
  expanded,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;

  return (
    <button
      type="button"
      className={`nav-button ${active ? "is-active" : ""}`}
      aria-label={item.label}
      title={expanded ? undefined : item.label}
      onClick={onClick}
    >
      <span className="nav-text">{item.label}</span>
      <span className="nav-icon">
        <Icon size={18} strokeWidth={2.1} />
      </span>
    </button>
  );
}
