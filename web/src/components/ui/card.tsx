import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn("flex flex-col gap-3 rounded-lg border bg-card py-4 text-card-foreground shadow-sm", className)}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex items-start justify-between gap-2 px-4", className)} {...props} />;
}

function CardTitle({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-title" className={cn("text-sm font-semibold leading-none", className)} {...props} />;
}

function CardDescription({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-description" className={cn("mt-1 text-xs text-muted-foreground", className)} {...props} />;
}

function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-4", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent };
