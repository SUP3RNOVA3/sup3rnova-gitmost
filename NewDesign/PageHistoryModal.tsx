/**
 * PageHistoryModal — редизайн окна «Page history».
 * Mantine v7. Light/dark. Полноразмерное модальное окно.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ЧТО ЭТО
 * ─────────────────────────────────────────────────────────────────────────
 * Окно истории версий страницы. Слева — панель навигации: мини-календарь
 * (heatmap: яркость дня = число ревизий, обводка = выбранный день) + плотный
 * список ревизий (одна ревизия = одна строка). Справа — реально отрендеренная
 * версия страницы с подсветкой изменений. Все контролы — в одну строку шапки.
 *
 * Ключевые решения:
 *  - Плотный список: одна ревизия на строку (аватар · время · автор · [SAVED]).
 *    Бейдж показывается ТОЛЬКО у сохранённых версий; всё остальное — autosave.
 *  - Агентские ревизии визуально отличаются: квадратный глиф роли (К/Ф) вместо
 *    круглого аватара пользователя + «via <кто запустил>».
 *  - Календарь объединён со списком в одной панели (мини-календарь = date jumper).
 *  - Highlight changes + навигация по изменениям (N of M, ↑/↓) вынесены в шапку.
 *  - Текущая версия помечена; Restore для неё недоступен.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * УСТАНОВКА / ИСПОЛЬЗОВАНИЕ
 * ─────────────────────────────────────────────────────────────────────────
 *   import { PageHistoryModal, Revision } from './PageHistoryModal';
 *
 *   <PageHistoryModal
 *     opened={open}
 *     onClose={() => setOpen(false)}
 *     revisions={revisions}                 // Revision[]
 *     selectedId={selId}
 *     onSelect={setSelId}                    // клик по ревизии → рендер справа
 *     renderVersion={(rev) => <ArticleView versionId={rev.id} />}  // ваш рендер страницы
 *     highlightChanges={hl}
 *     onToggleHighlight={setHl}
 *     changeNav={{ index: 1, total: 3, onPrev, onNext }}  // навигация по диффу
 *     onlySaved={onlySaved}
 *     onToggleOnlySaved={setOnlySaved}
 *     onRestore={(rev) => api.restore(rev.id)}   // async; текущая версия → disabled
 *   />
 *
 * Требует MantineProvider на корне приложения (defaultColorScheme="auto" для тем).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ФОРМАТ ДАННЫХ
 * ─────────────────────────────────────────────────────────────────────────
 *   interface Revision {
 *     id: string;
 *     at: Date | string;        // время ревизии; форматируется вызывающим/util-ом
 *     dayGroup: string;         // 'Today' | 'Yesterday' | 'Mon 12 Jul' — заголовок группы
 *     saved: boolean;           // true → бейдж SAVED; false → autosave (без бейджа)
 *     author: { name: string } & (
 *       | { kind: 'human' }
 *       | { kind: 'agent'; role: string; triggeredBy: string }  // роль + кто запустил
 *     );
 *     isCurrent?: boolean;      // текущая (последняя) версия — Restore недоступен
 *   }
 *
 * Ревизии приходят плоским массивом; группировка по dayGroup — на клиенте.
 * Никаких изменений API не требуется: агентское авторство берётся из author.kind.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * СОСТОЯНИЯ (нарисованы/поддержаны)
 * ─────────────────────────────────────────────────────────────────────────
 *  - Ревизия: обычная / hover / выбранная / текущая / агентская / человеческая.
 *  - Restore: default / disabled (выбрана текущая) / loading (спиннер после клика).
 *  - Highlight changes: on/off; при off навигация по изменениям неактивна.
 *  - Пустая история: одна версия / нет ревизий → EmptyState.
 *  - Тёмная тема: через токены Mantine (useMantineColorScheme, var(--mantine-*)).
 */
import { useMemo, useState, useCallback } from 'react';
import {
  Modal, Box, Group, Stack, Text, Switch, Avatar, Badge, Button, ActionIcon,
  ScrollArea, useMantineTheme, useMantineColorScheme,
} from '@mantine/core';

/* ─────────────────────────── Типы ─────────────────────────── */

export type Author =
  | { name: string; kind: 'human' }
  | { name: string; kind: 'agent'; role: string; triggeredBy: string };

export interface Revision {
  id: string;
  at: Date | string;
  atLabel: string;      // предформатированное «5:35AM»
  dayGroup: string;     // «Today» | «Yesterday» | «Mon 12 Jul»
  saved: boolean;
  author: Author;
  isCurrent?: boolean;
}

export interface CalendarDay {
  label: string;        // «12»
  inMonth: boolean;
  count: number;        // число ревизий за день (для heatmap)
  selected?: boolean;
  date: Date | string;
}

export interface PageHistoryModalProps {
  opened: boolean;
  onClose: () => void;
  revisions: Revision[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  renderVersion: (rev: Revision | null) => React.ReactNode;
  highlightChanges: boolean;
  onToggleHighlight: (v: boolean) => void;
  changeNav?: { index: number; total: number; onPrev: () => void; onNext: () => void };
  onlySaved: boolean;
  onToggleOnlySaved: (v: boolean) => void;
  onRestore: (rev: Revision) => Promise<void>;
  /** Ячейки текущего месяца календаря + управление. Необязательно — без него панель = только список. */
  calendar?: {
    monthLabel: string;      // «July 2025»
    weekdays: string[];      // ['Mon',…,'Sun']
    days: CalendarDay[];     // обычно 35/42 ячейки
    onPrevMonth: () => void;
    onNextMonth: () => void;
    onToday: () => void;
    onPickDay: (d: CalendarDay) => void;
  };
}

/* ─────────────────────────── Утилиты представления ─────────────────────────── */

const USER_PALETTE = ['#495057', '#e8590c', '#1c7ed6', '#7048e8', '#0ca678'];
function userColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return USER_PALETTE[h % USER_PALETTE.length];
}
const AGENT_GRAD: Record<string, string> = {
  'Корректор': 'linear-gradient(135deg,#20c997,#12b886)',
  'Фактчекер': 'linear-gradient(135deg,#4c6ef5,#7048e8)',
};
function agentGrad(role: string) { return AGENT_GRAD[role] ?? 'linear-gradient(135deg,#868e96,#495057)'; }

/** heatmap: число ревизий → фон/текст ячейки календаря. */
function heat(n: number, dark: boolean) {
  if (n === 0) return { bg: 'transparent', fg: dark ? '#5c5f66' : '#adb5bd' };
  if (n <= 2) return { bg: dark ? 'rgba(34,139,230,.20)' : '#e7f0ff', fg: dark ? '#74c0fc' : '#1971c2' };
  if (n <= 4) return { bg: dark ? 'rgba(34,139,230,.45)' : '#a5c8ff', fg: dark ? '#dbeafe' : '#0b3d91' };
  return { bg: '#4c8dff', fg: '#ffffff' };
}

/* ─────────────────────────── Строка ревизии ─────────────────────────── */

function RevisionRow({ rev, selected, onSelect }: { rev: Revision; selected: boolean; onSelect: () => void }) {
  const theme = useMantineTheme();
  const { colorScheme } = useMantineColorScheme();
  const dark = colorScheme === 'dark';
  const a = rev.author;
  const isAgent = a.kind === 'agent';

  return (
    <Group
      gap={8} wrap="nowrap" h={28} px="12px 14px" m="1px 6px"
      onClick={onSelect}
      style={{
        cursor: 'pointer', borderRadius: 7,
        background: selected ? (dark ? 'rgba(34,139,230,.14)' : '#eef4ff')
          : isAgent ? (dark ? 'rgba(112,72,232,.06)' : '#fbfaff') : undefined,
      }}
    >
      {/* аватар/глиф */}
      {isAgent ? (
        <Box style={{ flex: 'none', width: 16, height: 16, borderRadius: 4, background: agentGrad(a.role), display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', font: '700 8px system-ui' }}>
          {a.role[0]}
        </Box>
      ) : (
        <Box style={{ flex: 'none', width: 16, height: 16, borderRadius: '50%', background: userColor(a.name), display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', font: '700 8px system-ui' }}>
          {a.name[0].toUpperCase()}
        </Box>
      )}
      {/* время */}
      <Text fz={12.5} fw={rev.isCurrent ? 600 : 500} c={rev.isCurrent ? undefined : 'dimmed'} style={{ flex: 'none', minWidth: 58 }}>
        {rev.atLabel}
      </Text>
      {/* автор + via */}
      <Group gap={4} wrap="nowrap" style={{ flex: 1, minWidth: 0, alignItems: 'baseline', overflow: 'hidden' }}>
        <Text fz={12} fw={isAgent ? 600 : 400} c={isAgent ? undefined : 'dimmed'} truncate style={{ flex: 'none', maxWidth: 100 }}>
          {isAgent ? a.role : a.name}
        </Text>
        {isAgent && <Text fz={11} c="dimmed" truncate>· via {a.triggeredBy}</Text>}
      </Group>
      {/* бейдж — только SAVED */}
      {rev.saved && <Badge size="sm" radius="sm" variant="light" color="blue">SAVED</Badge>}
    </Group>
  );
}

/* ─────────────────────────── Мини-календарь ─────────────────────────── */

function MiniCalendar({ cal }: { cal: NonNullable<PageHistoryModalProps['calendar']> }) {
  const { colorScheme } = useMantineColorScheme();
  const dark = colorScheme === 'dark';
  return (
    <Box p="10px 12px 8px" style={(t) => ({ borderBottom: `1px solid ${t.colorScheme === 'dark' ? t.colors.dark[5] : t.colors.gray[1]}` })}>
      <Group gap={6} mb={6}>
        <ActionIcon variant="subtle" color="gray" size="sm" onClick={cal.onPrevMonth}>‹</ActionIcon>
        <Text fz={12} fw={600}>{cal.monthLabel}</Text>
        <ActionIcon variant="subtle" color="gray" size="sm" onClick={cal.onNextMonth}>›</ActionIcon>
        <Box style={{ flex: 1 }} />
        <Button variant="subtle" size="compact-xs" onClick={cal.onToday}>Today</Button>
      </Group>
      <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2, marginBottom: 2 }}>
        {cal.weekdays.map((w) => (
          <Text key={w} ta="center" fz={8.5} fw={600} c="dimmed">{w}</Text>
        ))}
      </Box>
      <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 2 }}>
        {cal.days.map((d, i) => {
          const h = heat(d.count, dark);
          return (
            <Box
              key={i} onClick={() => cal.onPickDay(d)}
              style={{
                position: 'relative', height: 26, borderRadius: 6, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: d.inMonth ? h.bg : 'transparent',
                boxShadow: d.selected ? `inset 0 0 0 2px ${dark ? '#f1f3f5' : '#1a1b1e'}` : undefined,
              }}
            >
              <Text fz={10.5} fw={d.selected ? 700 : 500} style={{ color: d.inMonth ? h.fg : (dark ? '#3a3d42' : '#dee2e6') }}>
                {d.label}
              </Text>
            </Box>
          );
        })}
      </Box>
      {/* легенда heatmap */}
      <Group gap={6} mt={8} align="center">
        <Text fz={9.5} c="dimmed">fewer</Text>
        {['#e7f0ff', '#a5c8ff', '#4c8dff'].map((c) => (
          <Box key={c} style={{ width: 14, height: 10, borderRadius: 2, background: c }} />
        ))}
        <Text fz={9.5} c="dimmed">more revisions</Text>
      </Group>
    </Box>
  );
}

/* ─────────────────────────── Окно ─────────────────────────── */

export function PageHistoryModal(props: PageHistoryModalProps) {
  const {
    opened, onClose, revisions, selectedId, onSelect, renderVersion,
    highlightChanges, onToggleHighlight, changeNav, onlySaved, onToggleOnlySaved,
    onRestore, calendar,
  } = props;
  const [restoring, setRestoring] = useState(false);

  const selected = revisions.find((r) => r.id === selectedId) ?? null;
  const isEmpty = revisions.length <= 1;

  // группировка по dayGroup, с фильтром Only saved
  const groups = useMemo(() => {
    const list = onlySaved ? revisions.filter((r) => r.saved) : revisions;
    const map: { head: string; items: Revision[] }[] = [];
    for (const r of list) {
      let g = map.find((x) => x.head === r.dayGroup);
      if (!g) { g = { head: r.dayGroup, items: [] }; map.push(g); }
      g.items.push(r);
    }
    return map;
  }, [revisions, onlySaved]);

  const restore = useCallback(async () => {
    if (!selected || selected.isCurrent) return;
    setRestoring(true);
    try { await onRestore(selected); } finally { setRestoring(false); }
  }, [selected, onRestore]);

  return (
    <Modal
      opened={opened} onClose={onClose} withCloseButton={false}
      size="80rem" radius="lg" padding={0}
      styles={{ body: { height: '80vh', maxHeight: 760, display: 'flex', flexDirection: 'column' } }}
      overlayProps={{ backgroundOpacity: 0.5, blur: 1 }}
    >
      {/* ── single-row toolbar ── */}
      <Group gap={14} h={60} px={16} wrap="nowrap" style={(t) => ({ flex: 'none', borderBottom: `1px solid ${t.colorScheme === 'dark' ? t.colors.dark[5] : t.colors.gray[1]}` })}>
        <Text fz={16} fw={600}>Page history</Text>
        <Box style={(t) => ({ width: 1, height: 22, background: t.colorScheme === 'dark' ? t.colors.dark[4] : t.colors.gray[2] })} />
        <Stack gap={1} style={{ minWidth: 0 }}>
          <Text fz={12} fw={600} truncate>{selected ? `${selected.dayGroup} · ${selected.atLabel}` : '—'}</Text>
          <Text fz={10.5} c="dimmed">selected version</Text>
        </Stack>

        <Box style={{ flex: 1 }} />

        {/* diff cluster */}
        <Group gap={2} p={3} wrap="nowrap" style={(t) => ({ background: t.colorScheme === 'dark' ? t.colors.dark[6] : '#f4f6f8', borderRadius: 10 })}>
          <Button variant="white" size="compact-sm" onClick={() => onToggleHighlight(!highlightChanges)}
            leftSection={<Switch checked={highlightChanges} onChange={() => {}} size="xs" tabIndex={-1} styles={{ track: { cursor: 'pointer' } }} />}
            styles={{ root: { boxShadow: '0 1px 2px rgba(0,0,0,.08)' } }}>
            Highlight changes
          </Button>
          {changeNav && (
            <>
              <Text fz={12} fw={600} c="dimmed" px={6}>{changeNav.index} / {changeNav.total}</Text>
              <Box style={{ display: 'flex' }}>
                <ActionIcon variant="subtle" color="gray" size="lg" disabled={!highlightChanges} onClick={changeNav.onPrev} style={{ width: 26 }}>↑</ActionIcon>
                <ActionIcon variant="subtle" color="gray" size="lg" disabled={!highlightChanges} onClick={changeNav.onNext} style={{ width: 26 }}>↓</ActionIcon>
              </Box>
            </>
          )}
        </Group>

        <Box style={(t) => ({ width: 1, height: 22, background: t.colorScheme === 'dark' ? t.colors.dark[4] : t.colors.gray[2] })} />

        <Button color="blue" onClick={restore} loading={restoring} disabled={!selected || selected.isCurrent}>
          Restore this version
        </Button>
        <ActionIcon variant="subtle" color="gray" size="lg" onClick={onClose}>✕</ActionIcon>
      </Group>

      {/* ── body ── */}
      <Box style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* left: nav panel */}
        <Stack gap={0} style={(t) => ({ flex: 'none', width: 280, minHeight: 0, borderRight: `1px solid ${t.colorScheme === 'dark' ? t.colors.dark[5] : t.colors.gray[1]}`, background: t.colorScheme === 'dark' ? t.colors.dark[7] : '#fcfcfd' })}>
          <Group h={44} px={16} style={(t) => ({ flex: 'none', borderBottom: `1px solid ${t.colorScheme === 'dark' ? t.colors.dark[5] : t.colors.gray[1]}` })}>
            <Switch checked={onlySaved} onChange={(e) => onToggleOnlySaved(e.currentTarget.checked)} size="sm" label="Only saved" labelPosition="right" styles={{ label: { fontSize: 13, fontWeight: 500 } }} />
          </Group>

          {calendar && <MiniCalendar cal={calendar} />}

          <ScrollArea style={{ flex: 1 }}>
            {groups.map((g) => (
              <Box key={g.head}>
                <Text px={16} pt={9} pb={5} fz={10.5} fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: '.05em', position: 'sticky', top: 0, zIndex: 2, background: 'var(--mantine-color-body)' }}>
                  {g.head}
                </Text>
                {g.items.map((r) => (
                  <RevisionRow key={r.id} rev={r} selected={r.id === selectedId} onSelect={() => onSelect(r.id)} />
                ))}
              </Box>
            ))}
          </ScrollArea>
        </Stack>

        {/* right: rendered version */}
        <ScrollArea style={{ flex: 1, minWidth: 0 }} bg="var(--mantine-color-default-hover)">
          {isEmpty ? (
            <Stack align="center" justify="center" h="100%" gap={6} p={40}>
              <Text fw={600} fz={14}>No earlier versions</Text>
              <Text fz={12.5} c="dimmed" ta="center">У страницы пока одна версия — сравнивать не с чем.</Text>
            </Stack>
          ) : (
            <Box p="26px 0" maw={660} mx="auto">
              {renderVersion(selected)}
            </Box>
          )}
        </ScrollArea>
      </Box>
    </Modal>
  );
}

export default PageHistoryModal;
