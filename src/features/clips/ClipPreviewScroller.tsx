import React from "react";

// Custom scroller so the styled scrollbar lands on the actual scrollable
// element. By default react-virtuoso's `className` prop goes to the outer
// wrapper, not the scroller, so ::-webkit-scrollbar selectors miss.
export const ClipPreviewScroller = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function ClipPreviewScroller({ className, children, ...rest }, ref) {
    return (
      <div
        {...rest}
        ref={ref}
        className={`clip-preview-grid-scroller${className ? ` ${className}` : ""}`}
      >
        {children}
      </div>
    );
  },
);
