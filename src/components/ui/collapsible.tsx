import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

function Collapsible({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

/**
 * The trigger draws its own caret so every collapsible in the app points the
 * same way: `>` while collapsed, turned down once open. Callers pass only the
 * label. The caret is sized in `em`, so it tracks whatever text size the
 * trigger is set in.
 *
 * `asChild` is off the table for that reason: it would hand Radix's Slot two
 * children — the caret and the label — and Slot takes exactly one. Rejecting
 * it in the type turns what would be a render-time throw into a build error.
 */
function CollapsibleTrigger({
  className,
  children,
  ...props
}: Omit<
  React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>,
  'asChild'
> & { asChild?: never }) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      className={cn('group', className)}
      {...props}
    >
      <ChevronRight className="size-[1em] shrink-0 transition-transform group-data-[state=open]:rotate-90" />
      {children}
    </CollapsiblePrimitive.CollapsibleTrigger>
  );
}

function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      {...props}
    />
  );
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
