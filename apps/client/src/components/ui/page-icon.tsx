import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Button,
  Group,
  Popover,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useClickOutside } from "@mantine/hooks";
import { IconFileDescription } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  parseIconRef,
  serializeIconRef,
  resolvePageIconColor,
  pageIconBg,
  pageIconFg,
  PAGE_ICON_PALETTE,
  type PageIconColor,
} from "@/lib/icon-ref";
import { LucideGlyph, isValidIconName } from "./lucide/lucide-glyph";
import { LucideIconGrid } from "./lucide/lucide-icon-grid";

// The rounded color box must not exceed the sidebar row height (~18-20px) so the
// tree rows never grow.
const MAX_BOX = 20;

export interface PageIconProps {
  /** The stored `pages.icon` value (IconRef JSON, a legacy emoji, or null). */
  value: string | null | undefined;
  size?: number;
}

/**
 * Renders a page icon from its stored value. A valid IconRef renders as a Lucide
 * glyph inside a rounded palette-colored box; anything else (null, a legacy
 * emoji, malformed JSON) falls back to the neutral file glyph. Never renders a
 * raw stored value.
 */
export function PageIcon({ value, size = 18 }: PageIconProps) {
  const ref = parseIconRef(value);

  if (!ref || !isValidIconName(ref.name)) {
    return (
      <IconFileDescription
        size={size}
        color="var(--mantine-color-gray-6)"
        aria-hidden="true"
      />
    );
  }

  const color = resolvePageIconColor(ref.color);
  const box = Math.min(size, MAX_BOX);

  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: box,
        height: box,
        borderRadius: 4,
        flexShrink: 0,
        backgroundColor: pageIconBg(color),
      }}
    >
      <LucideGlyph
        name={ref.name}
        size={Math.round(box * 0.7)}
        color={pageIconFg(color)}
      />
    </span>
  );
}

export interface PageIconPickerProps {
  value: string | null | undefined;
  /** Called with the serialized IconRef JSON when an icon is picked. */
  onChange: (json: string) => void;
  onRemove: () => void;
  readOnly?: boolean;
  actionIconProps?: {
    size?: string | number;
    variant?: string;
    tabIndex?: number;
  };
}

/**
 * The article-icon picker: a Popover whose trigger is the current {@link PageIcon}
 * and whose dropdown lazily renders the color palette + the Lucide icon grid +
 * Remove. On pick it serializes `{name,color}` and calls `onChange` with the
 * JSON string. Open/close/Escape/click-outside behavior mirrors the emoji
 * picker (`components/ui/emoji-picker.tsx`).
 */
export function PageIconPicker({
  value,
  onChange,
  onRemove,
  readOnly = false,
  actionIconProps,
}: PageIconPickerProps) {
  const { t } = useTranslation();
  const [opened, handlers] = useDisclosure(false);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [dropdown, setDropdown] = useState<HTMLDivElement | null>(null);

  const parsed = useMemo(() => parseIconRef(value), [value]);
  const [color, setColor] = useState<PageIconColor>(
    resolvePageIconColor(parsed?.color),
  );

  // Keep the pending color in sync with the current value when it changes.
  useEffect(() => {
    setColor(resolvePageIconColor(parsed?.color));
  }, [parsed?.color]);

  useClickOutside(
    () => handlers.close(),
    ["mousedown", "touchstart"],
    [dropdown, target],
  );

  // Mantine's popover closeOnEscape is unreliable here; attach a window keydown
  // only while open (same pattern as the emoji picker).
  useEffect(() => {
    if (!opened) return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        handlers.close();
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [opened, handlers]);

  const handlePick = (name: string) => {
    onChange(serializeIconRef({ name, color }));
    handlers.close();
  };

  const handlePickColor = (next: PageIconColor) => {
    setColor(next);
    // If there is already a valid icon, recolor it immediately.
    if (parsed && isValidIconName(parsed.name)) {
      onChange(serializeIconRef({ name: parsed.name, color: next }));
    }
  };

  const handleRemove = () => {
    onRemove();
    handlers.close();
  };

  return (
    <Popover
      opened={opened}
      onClose={handlers.close}
      width={332}
      position="bottom-start"
      disabled={readOnly}
      closeOnEscape
    >
      <Popover.Target ref={setTarget}>
        <ActionIcon
          variant={(actionIconProps?.variant as never) || "transparent"}
          size={actionIconProps?.size as never}
          tabIndex={actionIconProps?.tabIndex}
          onClick={handlers.toggle}
          aria-label={t("Pick icon")}
          aria-haspopup="dialog"
          aria-expanded={opened}
        >
          <PageIcon value={value} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown ref={setDropdown} p="sm">
        {opened && (
          <>
            <Text size="xs" c="dimmed" mb={4}>
              {t("Color")}
            </Text>
            <Group gap={6} mb="sm">
              {PAGE_ICON_PALETTE.map((token) => (
                <Tooltip key={token} label={token} openDelay={400} withArrow>
                  <UnstyledButton
                    type="button"
                    aria-label={token}
                    aria-pressed={token === color}
                    onClick={() => handlePickColor(token)}
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: "50%",
                      backgroundColor: pageIconBg(token),
                      border:
                        token === color
                          ? "2px solid var(--mantine-color-default-color)"
                          : "2px solid transparent",
                    }}
                  />
                </Tooltip>
              ))}
            </Group>
            <LucideIconGrid onPick={handlePick} />
            <Group justify="flex-end" mt="xs">
              <Button variant="default" c="gray" size="xs" onClick={handleRemove}>
                {t("Remove")}
              </Button>
            </Group>
          </>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}

export default PageIcon;
