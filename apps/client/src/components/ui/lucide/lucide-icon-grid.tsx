import { useMemo, useState } from "react";
import { SimpleGrid, Text, TextInput, Tooltip, UnstyledButton } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { dynamicIconImports } from "lucide-react/dynamic";
import { LucideGlyph } from "./lucide-glyph";
import { CURATED_ICON_NAMES } from "./curated-icons";

// All valid icon names, sorted once. `dynamicIconImports` keys ARE the valid
// picker names.
const ALL_ICON_NAMES = Object.keys(dynamicIconImports).sort();

// Never render more than this many buttons at once — the full list is ~2k icons,
// so an un-windowed grid would be unusable.
const MAX_RENDER = 120;

export interface LucideIconGridProps {
  /** Show the built-in search box (default true). */
  search?: boolean;
  onPick: (name: string) => void;
}

/**
 * Searchable Lucide icon grid. Before the user types it shows a curated set of
 * common icons; while typing it filters the full catalog by substring, renders
 * at most {@link MAX_RENDER} matches, and — when there are more — shows the first
 * window plus a "refine your search" hint. Reused by both the article picker
 * (with a palette) and the role picker (grid only).
 */
export function LucideIconGrid({ search = true, onPick }: LucideIconGridProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  const { names, total, truncated } = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") {
      return {
        names: CURATED_ICON_NAMES,
        total: CURATED_ICON_NAMES.length,
        truncated: false,
      };
    }
    const matches = ALL_ICON_NAMES.filter((n) => n.includes(q));
    return {
      names: matches.slice(0, MAX_RENDER),
      total: matches.length,
      truncated: matches.length > MAX_RENDER,
    };
  }, [query]);

  return (
    <div>
      {search && (
        <TextInput
          size="xs"
          mb="xs"
          leftSection={<IconSearch size={14} />}
          placeholder={t("Search icons")}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          aria-label={t("Search icons")}
        />
      )}

      {names.length === 0 ? (
        <Text size="xs" c="dimmed" ta="center" py="md">
          {t("No icons found")}
        </Text>
      ) : (
        <div style={{ maxHeight: 220, overflowY: "auto" }}>
          <SimpleGrid cols={8} spacing={4} verticalSpacing={4}>
            {names.map((name) => (
              <Tooltip key={name} label={name} openDelay={400} withArrow>
                <UnstyledButton
                  type="button"
                  onClick={() => onPick(name)}
                  aria-label={name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: 30,
                    borderRadius: 6,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background =
                      "var(--mantine-color-default-hover)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "";
                  }}
                >
                  <LucideGlyph name={name} size={18} />
                </UnstyledButton>
              </Tooltip>
            ))}
          </SimpleGrid>
        </div>
      )}

      {truncated && (
        <Text size="xs" c="dimmed" ta="center" mt="xs">
          {t("Showing first {{count}} of {{total}} — refine your search", {
            count: MAX_RENDER,
            total,
          })}
        </Text>
      )}
    </div>
  );
}

export default LucideIconGrid;
