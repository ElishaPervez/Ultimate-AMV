import React, { useState, useRef, useEffect, useId } from "react";
import { ChevronDown, Search, Check, X } from "lucide-react";

export interface DropdownOption<T> {
  value: T;
  label: string;
  description?: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  disabled?: boolean;
}

interface SingleDropdownProps<T> {
  multiple?: false;
  value: T;
  onChange: (value: T) => void;
}

interface MultiDropdownProps<T> {
  multiple: true;
  value: T[];
  onChange: (value: T[]) => void;
}

export type DropdownProps<T> = (SingleDropdownProps<T> | MultiDropdownProps<T>) & {
  options: DropdownOption<T>[];
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  align?: "left" | "right";
  icon?: React.ComponentType<{ size?: number; className?: string }>;
};

export function Dropdown<T>({
  options,
  value,
  onChange,
  multiple = false,
  placeholder = "Select option...",
  disabled = false,
  searchable = false,
  className = "",
  triggerClassName = "",
  menuClassName = "",
  align = "left",
  icon: TriggerIcon,
}: DropdownProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionsRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const dropdownId = useId();
  const triggerId = useId();

  // Normalize current values
  const selectedValues = multiple ? (value as T[]) : [value as T];

  // Filter options based on query
  const filteredOptions = options.filter((option) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    const labelMatch = option.label.toLowerCase().includes(query);
    const descMatch = option.description?.toLowerCase().includes(query) ?? false;
    return labelMatch || descMatch;
  });

  // Toggle open / close
  const toggleDropdown = () => {
    if (disabled) return;
    setIsOpen(!isOpen);
    setSearchQuery("");
    setFocusedIndex(-1);
  };

  // Close dropdown and refocus trigger
  const closeDropdown = (refocus = true) => {
    setIsOpen(false);
    setSearchQuery("");
    setFocusedIndex(-1);
    if (refocus && triggerRef.current) {
      triggerRef.current.focus();
    }
  };

  // Handle outside click
  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        closeDropdown(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [isOpen]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && searchable && searchInputRef.current) {
      // Small timeout to ensure DOM render before focusing
      const timer = setTimeout(() => searchInputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen, searchable]);

  // Reset focus index when options change
  useEffect(() => {
    setFocusedIndex(-1);
  }, [searchQuery]);

  // Keep focused option in view
  useEffect(() => {
    if (focusedIndex >= 0 && optionsRefs.current[focusedIndex]) {
      optionsRefs.current[focusedIndex]?.scrollIntoView({
        block: "nearest",
      });
    }
  }, [focusedIndex]);

  // Handle selecting an option
  const handleSelect = (option: DropdownOption<T>) => {
    if (option.disabled) return;

    if (multiple) {
      const currentValues = value as T[];
      const isAlreadySelected = currentValues.includes(option.value);
      const nextValues = isAlreadySelected
        ? currentValues.filter((v) => v !== option.value)
        : [...currentValues, option.value];
      (onChange as (value: T[]) => void)(nextValues);
    } else {
      (onChange as (value: T) => void)(option.value);
      closeDropdown();
    }
  };

  // Keyboard navigation
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;

    switch (event.key) {
      case "Enter":
      case " ":
        event.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else if (focusedIndex >= 0 && focusedIndex < filteredOptions.length) {
          handleSelect(filteredOptions[focusedIndex]);
        }
        break;

      case "Escape":
        event.preventDefault();
        closeDropdown();
        break;

      case "ArrowDown":
        event.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
          setFocusedIndex(0);
        } else {
          setFocusedIndex((prev) => {
            const next = prev + 1;
            return next < filteredOptions.length ? next : prev;
          });
        }
        break;

      case "ArrowUp":
        event.preventDefault();
        if (isOpen) {
          setFocusedIndex((prev) => {
            const next = prev - 1;
            return next >= 0 ? next : prev;
          });
        }
        break;

      case "Tab":
        // Closes without preventDefault to allow natural tab navigation out
        closeDropdown(false);
        break;

      default:
        break;
    }
  };

  // Render trigger display content
  const renderTriggerContent = () => {
    if (multiple) {
      const selectedOptions = options.filter((o) => selectedValues.includes(o.value));
      if (selectedOptions.length === 0) {
        return <span className="custom-dropdown-placeholder">{placeholder}</span>;
      }
      return (
        <div className="custom-dropdown-badges">
          {selectedOptions.map((opt) => (
            <span key={String(opt.value)} className="custom-dropdown-badge">
              {opt.icon && <opt.icon size={12} className="custom-dropdown-option-icon" />}
              <span>{opt.label}</span>
              <button
                type="button"
                className="custom-dropdown-badge-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  handleSelect(opt);
                }}
                aria-label={`Remove ${opt.label}`}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      );
    }

    const currentOption = options.find((o) => o.value === value);
    if (!currentOption) {
      return <span className="custom-dropdown-placeholder">{placeholder}</span>;
    }

    return (
      <div className="custom-dropdown-trigger-content">
        {currentOption.icon && (
          <currentOption.icon size={14} className="custom-dropdown-option-icon" />
        )}
        <span className="custom-dropdown-trigger-label">{currentOption.label}</span>
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className={`custom-dropdown-container ${className}`}
      onKeyDown={handleKeyDown}
    >
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        disabled={disabled}
        className={`custom-dropdown-trigger spring-motion ${triggerClassName}`}
        onClick={toggleDropdown}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? dropdownId : undefined}
      >
        <div className="custom-dropdown-trigger-content">
          {TriggerIcon && <TriggerIcon size={14} className="custom-dropdown-trigger-icon" />}
          {renderTriggerContent()}
        </div>
        <ChevronDown
          size={14}
          className={`custom-dropdown-chevron ${isOpen ? "is-open" : ""}`}
        />
      </button>

      {isOpen && (
        <div
          id={dropdownId}
          className={`custom-dropdown-menu ${align === "right" ? "is-right" : ""} ${menuClassName}`}
          role="listbox"
          aria-labelledby={triggerId}
          aria-multiselectable={multiple}
        >
          {searchable && (
            <div className="custom-dropdown-search-wrap">
              <Search size={12} className="custom-dropdown-search-icon" />
              <input
                ref={searchInputRef}
                type="text"
                className="custom-dropdown-search-input"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}

          <div className="custom-dropdown-options-list">
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option, index) => {
                const isSelected = selectedValues.includes(option.value);
                const isFocused = index === focusedIndex;
                const IconComponent = option.icon;

                return (
                  <button
                    ref={(el) => {
                      optionsRefs.current[index] = el;
                    }}
                    key={String(option.value)}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={option.disabled}
                    className={`custom-dropdown-option ${isSelected ? "is-selected" : ""} ${
                      isFocused ? "is-focused" : ""
                    } ${option.disabled ? "is-disabled" : ""}`}
                    onClick={() => handleSelect(option)}
                    onMouseEnter={() => setFocusedIndex(index)}
                  >
                    {IconComponent && (
                      <IconComponent size={14} className="custom-dropdown-option-icon" />
                    )}
                    <div className="custom-dropdown-option-info">
                      <span className="custom-dropdown-option-label">{option.label}</span>
                      {option.description && (
                        <span className="custom-dropdown-option-desc">{option.description}</span>
                      )}
                    </div>
                    {isSelected && !multiple && (
                      <span className="custom-dropdown-option-check">
                        <Check size={14} />
                      </span>
                    )}
                    {multiple && (
                      <span className="custom-dropdown-option-check">
                        <div
                          style={{
                            width: 14,
                            height: 14,
                            border: "1px solid var(--accent-border-strong)",
                            borderRadius: 3,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            background: isSelected ? "var(--cyan)" : "transparent",
                          }}
                        >
                          {isSelected && <Check size={10} color="var(--theme-accent-contrast)" strokeWidth={3} />}
                        </div>
                      </span>
                    )}
                  </button>
                );
              })
            ) : (
              <div className="custom-dropdown-no-results">No results found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
