import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface State {
  error: Error | null;
}

/**
 * A render error must never leave a blank page.
 *
 * The panel is the only way to see what the gate is doing without a terminal,
 * and a blank screen is indistinguishable from a daemon that is down — while
 * the actual message ("Cannot read properties of undefined") is exactly the
 * thing worth reading. One boundary around the routed content keeps the sidebar
 * and its connection indicator alive, so the rest of the panel stays usable.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The browser console keeps the component stack; the panel shows the message.
    console.error("面板渲染失败", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <Card>
          <CardHeader className="flex-col">
            <CardTitle>这个页面渲染失败了</CardTitle>
            <p className="text-xs text-muted-foreground">
              侧栏与 daemon 连接还在；下面是原始错误，切到别的页面或重新加载即可恢复。
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[12px] whitespace-pre-wrap">
              {this.state.error.message}
            </pre>
            <Button className="w-fit" variant="outline" onClick={() => this.setState({ error: null })}>
              重试渲染
            </Button>
          </CardContent>
        </Card>
      );
    }
    return this.props.children;
  }
}
