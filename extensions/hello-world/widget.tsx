import type { RefreshableBabyMenuWidget } from "../../src/shared/contracts";

const examplePrompts = [
  "add a battery widget that shows current charge and power source",
  "add a calendar widget that shows my next event and time until it starts",
  "add a cpu temp widget that shows current temperature and fan status",
];

function HelloWorldView() {
  return (
    <div
      className="hello-world-widget"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-7)",
        padding: "var(--space-3) 0 var(--space-4)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
        }}
      >
        <span className="status">ready</span>
        <span
          style={{
            color: "var(--ink-strong)",
            fontSize: "var(--fs-3xl)",
            fontWeight: "var(--weight-light)",
            letterSpacing: "var(--tracking-value)",
            lineHeight: "var(--lh-tight)",
          }}
        >
          hello world
        </span>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
          }}
        >
          <p style={{ color: "var(--ink-strong)", fontSize: "var(--fs-md)" }}>
            tell baby_menu what to build.
          </p>
          <p style={{ color: "var(--ink-muted)", fontSize: "var(--fs-base)" }}>
            paste an example into the prompt below, or ask for any widget you want.
          </p>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
        }}
      >
        <span className="label">examples</span>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
          }}
        >
          {examplePrompts.map((example) => (
            <span
              key={example}
              style={{
                alignItems: "flex-start",
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-sm)",
                color: "var(--ink)",
                display: "flex",
                fontSize: "var(--fs-sm)",
                gap: "var(--space-3)",
                lineHeight: "var(--lh-body)",
                padding: "var(--space-4) var(--space-5)",
              }}
            >
              <span style={{ color: "var(--signal-live)", flex: "0 0 auto" }}>›</span>
              <span>{example}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export const helloWorldWidget: RefreshableBabyMenuWidget = {
  id: "hello-world",
  title: "baby menu",
  render: () => <HelloWorldView />,
};
