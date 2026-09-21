import {
  FormattingToolbar,
  ComponentsContext,
  getFormattingToolbarItems,
  useBlockNoteEditor,
  useDictionary,
  useEditorState,
} from "@blocknote/react";
import type { ComponentProps, Components } from "@blocknote/react";
import {
  components as shadcnComponents,
  ShadCNDefaultComponents,
  useShadCNComponentsContext,
} from "@blocknote/shadcn";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";

type ToolbarPointerEvent = React.PointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>;
type ToolbarTouchEvent = React.TouchEvent<HTMLElement>;
type ToolbarButtonProps = ComponentProps["FormattingToolbar"]["Button"];
type MenuPosition = ComponentProps["Generic"]["Menu"]["Root"]["position"];
type PopoverSide = "top" | "right" | "bottom" | "left";
type PopoverAlign = "start" | "end";

const PortalTargetContext = createContext<HTMLElement | undefined>(undefined);
const COLORS = ["default", "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;

function preserveToolbarSelection(event: ToolbarPointerEvent | ToolbarTouchEvent) {
  event.preventDefault();
}

// Radix menus/popovers autofocus their content on open and refocus the trigger
// on close; either would blur the editor and dismiss the mobile keyboard.
function preventFocusTransfer(event: Event) {
  event.preventDefault();
}

function cx(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(" ").trim();
}

function chainHandlers<E>(existing: unknown, next: (event: E) => void) {
  return (event: E) => {
    if (typeof existing === "function") (existing as (event: E) => void)(event);
    next(event);
  };
}

function cloneTriggerChild(children: ReactNode, props: Record<string, unknown>) {
  if (!isValidElement(children)) return children;

  // BlockNote/shadcn toolbar buttons forward unknown event props to the real button.
  // The cast keeps this local to the component override instead of weakening app types.
  return cloneElement(children as ReactElement<Record<string, unknown>>, props);
}

function useShadCN() {
  return useShadCNComponentsContext() ?? ShadCNDefaultComponents;
}

// BlockNote positions ("bottom-start", …) map 1:1 onto Radix side/align.
function splitPosition(position: MenuPosition): { side?: PopoverSide; align?: PopoverAlign } {
  if (!position) return {};
  const [side, align] = position.split("-") as [PopoverSide, PopoverAlign | undefined];
  return { side, align };
}

// preventDefault on pointerdown keeps the editor selection alive, but it also
// suppresses Radix's built-in pointerdown open-toggle, so we toggle on click
// (which still fires after a cancelled pointerdown). The toggle uses the open
// state captured at pointerdown time because Radix's outside-press dismissal
// may have already closed the menu by the time click fires — a naive toggle
// would instantly reopen it.
function useSelectionPreservingMenuToggle(opened: boolean, setOpened: (opened: boolean) => void) {
  const openedAtPointerDown = useRef(false);

  return {
    tabIndex: -1,
    onPointerDown: (event: ToolbarPointerEvent) => {
      openedAtPointerDown.current = opened;
      preserveToolbarSelection(event);
    },
    onTouchStart: preserveToolbarSelection,
    onMouseDown: preserveToolbarSelection,
    onClick: () => {
      setOpened(!openedAtPointerDown.current);
    },
  };
}

function ColorIcon(props: { textColor?: string; backgroundColor?: string; size?: number }) {
  const size = props.size ?? 20;

  return (
    <div
      className="bn-color-icon"
      data-background-color={props.backgroundColor ?? "default"}
      data-text-color={props.textColor ?? "default"}
      style={{
        pointerEvents: "none",
        fontSize: `${size * 0.75}px`,
        height: `${size}px`,
        lineHeight: `${size}px`,
        textAlign: "center",
        width: `${size}px`,
      }}
    >
      A
    </div>
  );
}

function TickIndicator(props: { checked: boolean }) {
  if (!props.checked) return <div className="bn-tick-space" />;
  return <Check size={10} className="bn-tick-icon" />;
}

function MobileColorStyleButton() {
  const editor = useBlockNoteEditor<any, any, any>();
  const dict = useDictionary();
  const [opened, setOpened] = useState(false);
  const portalTarget = useContext(PortalTargetContext);
  const ShadCN = useShadCN();
  const triggerProps = useSelectionPreservingMenuToggle(opened, setOpened);
  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (
        !editor.isEditable ||
        !(editor.getSelection()?.blocks || [editor.getTextCursorPosition().block]).find(
          (block) => block.content !== undefined
        )
      ) {
        return undefined;
      }

      return {
        textColor: String(editor.getActiveStyles().textColor || "default"),
        backgroundColor: String(editor.getActiveStyles().backgroundColor || "default"),
      };
    },
  });

  if (state === undefined) return null;

  const setTextColor = (color: string) => {
    color === "default" ? editor.removeStyles({ textColor: color }) : editor.addStyles({ textColor: color });
    setTimeout(() => editor.focus());
  };

  const setBackgroundColor = (color: string) => {
    color === "default"
      ? editor.removeStyles({ backgroundColor: color })
      : editor.addStyles({ backgroundColor: color });
    setTimeout(() => editor.focus());
  };

  return (
    <ShadCN.DropdownMenu.DropdownMenu open={opened} onOpenChange={setOpened} modal={false}>
      <ShadCN.DropdownMenu.DropdownMenuTrigger asChild>
        <ShadCN.Button.Button
          aria-label={dict.formatting_toolbar.colors.tooltip}
          data-test="colors"
          variant="ghost"
          size="sm"
          className="px-2"
          {...triggerProps}
        >
          <ColorIcon textColor={state.textColor} backgroundColor={state.backgroundColor} size={20} />
        </ShadCN.Button.Button>
      </ShadCN.DropdownMenu.DropdownMenuTrigger>
      <DropdownMenuPrimitive.Portal container={portalTarget}>
        <ShadCN.DropdownMenu.DropdownMenuContent
          className="bn-menu-dropdown bn-color-picker-dropdown"
          onCloseAutoFocus={preventFocusTransfer}
        >
          <ShadCN.DropdownMenu.DropdownMenuLabel>{dict.color_picker.text_title}</ShadCN.DropdownMenu.DropdownMenuLabel>
          {COLORS.map((color) => (
            <ShadCN.DropdownMenu.DropdownMenuItem
              key={`text-${color}`}
              data-test={`text-color-${color}`}
              onPointerDown={preserveToolbarSelection}
              onTouchStart={preserveToolbarSelection}
              onMouseDown={preserveToolbarSelection}
              onClick={() => {
                setTextColor(color);
                setOpened(false);
              }}
            >
              <ColorIcon textColor={color} />
              {dict.color_picker.colors[color]}
              <TickIndicator checked={state.textColor === color} />
            </ShadCN.DropdownMenu.DropdownMenuItem>
          ))}
          <ShadCN.DropdownMenu.DropdownMenuLabel>
            {dict.color_picker.background_title}
          </ShadCN.DropdownMenu.DropdownMenuLabel>
          {COLORS.map((color) => (
            <ShadCN.DropdownMenu.DropdownMenuItem
              key={`background-${color}`}
              data-test={`background-color-${color}`}
              onPointerDown={preserveToolbarSelection}
              onTouchStart={preserveToolbarSelection}
              onMouseDown={preserveToolbarSelection}
              onClick={() => {
                setBackgroundColor(color);
                setOpened(false);
              }}
            >
              <ColorIcon backgroundColor={color} />
              {dict.color_picker.colors[color]}
              <TickIndicator checked={state.backgroundColor === color} />
            </ShadCN.DropdownMenu.DropdownMenuItem>
          ))}
        </ShadCN.DropdownMenu.DropdownMenuContent>
      </DropdownMenuPrimitive.Portal>
    </ShadCN.DropdownMenu.DropdownMenu>
  );
}

function MobileToolbarButton(props: ToolbarButtonProps) {
  const Button = shadcnComponents.FormattingToolbar.Button as React.ComponentType<Record<string, unknown>>;
  const buttonProps = props as Record<string, unknown>;

  return (
    <Button
      {...buttonProps}
      tabIndex={-1}
      onPointerDown={buttonProps.onPointerDown ?? preserveToolbarSelection}
      onTouchStart={buttonProps.onTouchStart ?? preserveToolbarSelection}
      onMouseDown={buttonProps.onMouseDown ?? preserveToolbarSelection}
    />
  );
}

function MobileToolbarSelect(props: ComponentProps["FormattingToolbar"]["Select"]) {
  const { className, items, isDisabled } = props;
  const [opened, setOpened] = useState(false);
  const portalTarget = useContext(PortalTargetContext);
  const ShadCN = useShadCN();
  const triggerProps = useSelectionPreservingMenuToggle(opened, setOpened);
  const selectedItem = items.find((item) => item.isSelected);

  if (!selectedItem) return null;

  return (
    <ShadCN.DropdownMenu.DropdownMenu open={opened} onOpenChange={setOpened} modal={false}>
      <ShadCN.DropdownMenu.DropdownMenuTrigger asChild>
        <ShadCN.Button.Button variant="ghost" size="sm" disabled={isDisabled} {...triggerProps}>
          {selectedItem.icon}
          {selectedItem.text}
          <ChevronDown />
        </ShadCN.Button.Button>
      </ShadCN.DropdownMenu.DropdownMenuTrigger>
      <DropdownMenuPrimitive.Portal container={portalTarget}>
        <ShadCN.DropdownMenu.DropdownMenuContent
          className={cx(className, "bn-mobile-toolbar-select-dropdown")}
          onCloseAutoFocus={preventFocusTransfer}
        >
          {items.map((item) => (
            <ShadCN.DropdownMenu.DropdownMenuItem
              key={item.text}
              disabled={item.isDisabled}
              onPointerDown={preserveToolbarSelection}
              onTouchStart={preserveToolbarSelection}
              onMouseDown={preserveToolbarSelection}
              onClick={() => {
                item.onClick();
                setOpened(false);
              }}
            >
              {item.icon}
              {item.text}
              <TickIndicator checked={item.isSelected} />
            </ShadCN.DropdownMenu.DropdownMenuItem>
          ))}
        </ShadCN.DropdownMenu.DropdownMenuContent>
      </DropdownMenuPrimitive.Portal>
    </ShadCN.DropdownMenu.DropdownMenu>
  );
}

type MenuControl = {
  opened: boolean;
  setOpened: (opened: boolean) => void;
  side?: PopoverSide;
  align?: PopoverAlign;
};

const MenuOpenContext = createContext<MenuControl | null>(null);

function MobileMenuRoot(props: ComponentProps["Generic"]["Menu"]["Root"]) {
  const { children, onOpenChange, position, sub } = props;
  const [opened, setOpenedState] = useState(false);
  const ShadCN = useShadCN();
  const setOpened = (value: boolean) => {
    setOpenedState(value);
    onOpenChange?.(value);
  };

  if (sub) {
    return <shadcnComponents.Generic.Menu.Root {...props} />;
  }

  return (
    <MenuOpenContext.Provider value={{ opened, setOpened, ...splitPosition(position) }}>
      <ShadCN.DropdownMenu.DropdownMenu open={opened} onOpenChange={setOpened} modal={false}>
        {children}
      </ShadCN.DropdownMenu.DropdownMenu>
    </MenuOpenContext.Provider>
  );
}

function MobileMenuTrigger(props: ComponentProps["Generic"]["Menu"]["Trigger"]) {
  const context = useContext(MenuOpenContext);
  const ShadCN = useShadCN();
  const openedAtPointerDown = useRef(false);

  if (props.sub || !context) {
    return <shadcnComponents.Generic.Menu.Trigger {...props} />;
  }

  const childProps = isValidElement(props.children)
    ? (props.children.props as Record<string, unknown>)
    : ({} as Record<string, unknown>);

  return (
    <ShadCN.DropdownMenu.DropdownMenuTrigger asChild>
      {cloneTriggerChild(props.children, {
        tabIndex: -1,
        onPointerDown: chainHandlers(childProps.onPointerDown, (event: ToolbarPointerEvent) => {
          openedAtPointerDown.current = context.opened;
          preserveToolbarSelection(event);
        }),
        onTouchStart: chainHandlers(childProps.onTouchStart, preserveToolbarSelection),
        onMouseDown: chainHandlers(childProps.onMouseDown, preserveToolbarSelection),
        // See useSelectionPreservingMenuToggle for why the toggle lives on click.
        onClick: chainHandlers(childProps.onClick, () => {
          context.setOpened(!openedAtPointerDown.current);
        }),
      })}
    </ShadCN.DropdownMenu.DropdownMenuTrigger>
  );
}

function MobileMenuItem(props: ComponentProps["Generic"]["Menu"]["Item"]) {
  const { className, children, icon, checked, subTrigger, onClick } = props;
  const ShadCN = useShadCN();

  // Mirrors @blocknote/shadcn's MenuItem: sub-trigger items render inline
  // inside the shadcn DropdownMenuSubTrigger.
  if (subTrigger) {
    return (
      <>
        {icon}
        {children}
      </>
    );
  }

  const preserveSelectionProps = {
    onPointerDown: preserveToolbarSelection,
    onTouchStart: preserveToolbarSelection,
    onMouseDown: preserveToolbarSelection,
  };

  if (checked !== undefined) {
    return (
      <ShadCN.DropdownMenu.DropdownMenuCheckboxItem
        className={cx(className, "gap-1", !checked && "px-2")}
        checked={checked}
        onClick={onClick}
        {...preserveSelectionProps}
      >
        {icon}
        {children}
      </ShadCN.DropdownMenu.DropdownMenuCheckboxItem>
    );
  }

  return (
    <ShadCN.DropdownMenu.DropdownMenuItem className={className} onClick={onClick} {...preserveSelectionProps}>
      {icon}
      {children}
    </ShadCN.DropdownMenu.DropdownMenuItem>
  );
}

function MobileMenuDropdown(props: ComponentProps["Generic"]["Menu"]["Dropdown"]) {
  const { className, children, sub } = props;
  const context = useContext(MenuOpenContext);
  const portalTarget = useContext(PortalTargetContext);
  const ShadCN = useShadCN();

  if (sub || !context) {
    return <shadcnComponents.Generic.Menu.Dropdown {...props} />;
  }

  return (
    <DropdownMenuPrimitive.Portal container={portalTarget}>
      <ShadCN.DropdownMenu.DropdownMenuContent
        className={className}
        side={context.side}
        align={context.align}
        onCloseAutoFocus={preventFocusTransfer}
      >
        {children}
      </ShadCN.DropdownMenu.DropdownMenuContent>
    </DropdownMenuPrimitive.Portal>
  );
}

type PopoverControl = {
  opened: boolean;
  setOpened: (opened: boolean) => void;
  portal: boolean;
  portalTarget?: HTMLElement;
  side?: PopoverSide;
  align?: PopoverAlign;
};

const PopoverOpenContext = createContext<PopoverControl | null>(null);

function MobilePopoverRoot(props: ComponentProps["Generic"]["Popover"]["Root"]) {
  const { children, onOpenChange, open, position, portalRoot } = props;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const fallbackPortalTarget = useContext(PortalTargetContext);
  const ShadCN = useShadCN();
  const opened = open ?? uncontrolledOpen;
  const setOpened = (value: boolean) => {
    setUncontrolledOpen(value);
    onOpenChange?.(value);
  };

  return (
    <PopoverOpenContext.Provider
      value={{
        opened,
        setOpened,
        // portalRoot === null means "render in place" (same as the previous
        // Mantine withinPortal={false} behavior).
        portal: portalRoot !== null,
        portalTarget: portalRoot ?? fallbackPortalTarget,
        ...splitPosition(position),
      }}
    >
      <ShadCN.Popover.Popover open={opened} onOpenChange={setOpened} modal={false}>
        {children}
      </ShadCN.Popover.Popover>
    </PopoverOpenContext.Provider>
  );
}

function MobilePopoverTrigger(props: ComponentProps["Generic"]["Popover"]["Trigger"]) {
  const context = useContext(PopoverOpenContext);
  const ShadCN = useShadCN();

  if (!context) {
    return <shadcnComponents.Generic.Popover.Trigger {...props} />;
  }

  const childProps = isValidElement(props.children)
    ? (props.children.props as Record<string, unknown>)
    : ({} as Record<string, unknown>);

  // Radix Popover toggles on click (which survives a cancelled pointerdown),
  // and its non-modal content ignores outside-presses on the trigger, so no
  // manual toggle is needed here.
  return (
    <ShadCN.Popover.PopoverTrigger asChild>
      {cloneTriggerChild(props.children, {
        tabIndex: -1,
        onPointerDown: chainHandlers(childProps.onPointerDown, preserveToolbarSelection),
        onTouchStart: chainHandlers(childProps.onTouchStart, preserveToolbarSelection),
        onMouseDown: chainHandlers(childProps.onMouseDown, preserveToolbarSelection),
      })}
    </ShadCN.Popover.PopoverTrigger>
  );
}

function MobilePopoverContent(props: ComponentProps["Generic"]["Popover"]["Content"]) {
  const { className, variant, children } = props;
  const context = useContext(PopoverOpenContext);
  const ShadCN = useShadCN();

  if (!context) {
    return <shadcnComponents.Generic.Popover.Content {...props} />;
  }

  const content = (
    <ShadCN.Popover.PopoverContent
      sideOffset={8}
      side={context.side}
      align={context.align}
      className={cx(
        className,
        "flex flex-col gap-2",
        variant === "panel-popover" && "w-fit max-w-none border-none p-0 shadow-none"
      )}
      onOpenAutoFocus={preventFocusTransfer}
      onCloseAutoFocus={preventFocusTransfer}
    >
      {children}
    </ShadCN.Popover.PopoverContent>
  );

  if (!context.portal) return content;

  return <PopoverPrimitive.Portal container={context.portalTarget}>{content}</PopoverPrimitive.Portal>;
}

export function MobileFormattingToolbar() {
  const [portalTarget, setPortalTarget] = useState<HTMLElement | undefined>(undefined);
  const toolbarItems = getFormattingToolbarItems();

  useEffect(() => {
    setPortalTarget(document.querySelector<HTMLElement>(".bn-shadcn") ?? document.body);
  }, []);

  const mobileComponents = useMemo<Components>(
    () => ({
      ...shadcnComponents,
      FormattingToolbar: {
        ...shadcnComponents.FormattingToolbar,
        Button: MobileToolbarButton,
        Select: MobileToolbarSelect,
      },
      Generic: {
        ...shadcnComponents.Generic,
        Menu: {
          ...shadcnComponents.Generic.Menu,
          Root: MobileMenuRoot,
          Trigger: MobileMenuTrigger,
          Item: MobileMenuItem,
          Dropdown: MobileMenuDropdown,
        },
        Popover: {
          ...shadcnComponents.Generic.Popover,
          Root: MobilePopoverRoot,
          Trigger: MobilePopoverTrigger,
          Content: MobilePopoverContent,
        },
        Toolbar: {
          ...shadcnComponents.Generic.Toolbar,
          Button: MobileToolbarButton,
        },
      },
    }),
    []
  );

  return (
    <PortalTargetContext.Provider value={portalTarget}>
      <ComponentsContext.Provider value={mobileComponents}>
        <FormattingToolbar>
          {toolbarItems.flatMap((item) => {
            if (item.key === "colorStyleButton") {
              return [];
            }

            if (item.key === "blockTypeSelect") {
              return [item, <MobileColorStyleButton key="colorStyleButton" />];
            }

            return [item];
          })}
        </FormattingToolbar>
      </ComponentsContext.Provider>
    </PortalTargetContext.Provider>
  );
}
