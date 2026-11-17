// The access editor, loaded when it is first shown (docs/plan.md §1.122): the Team screen, the back
// office's client People and the invite form show it only on demand, and the web app's first load
// has a budget (scripts/web-size.mjs). Nothing shows while it loads (it is a few kB).
import { type ComponentProps, lazy, Suspense } from "react";

const Editor = lazy(() => import("./Access").then((m) => ({ default: m.AccessEditor })));
const Fields = lazy(() => import("./Access").then((m) => ({ default: m.AccessFields })));

export function AccessEditor(props: ComponentProps<typeof Editor>) {
  return (
    <Suspense fallback={null}>
      <Editor {...props} />
    </Suspense>
  );
}

export function AccessFields(props: ComponentProps<typeof Fields>) {
  return (
    <Suspense fallback={null}>
      <Fields {...props} />
    </Suspense>
  );
}
