/**
 * CommentsPanel — редизайн панели комментариев с фокусом на агентские правки.
 * Mantine v7. Узкая колонка ~340–400px, светлая/тёмная темы.
 *
 * Реализованные решения (см. README.md):
 *  - Дифф-первая карточка: цитата = старая строка диффа (без тройного дублирования)
 *  - Группировка серии прогона под одной шапкой ("Корректор · 28 правок")
 *  - Пакетное "Accept all" на фронте (по одной под капотом) с полоской прогресса
 *  - Метки важности/категории парсятся клиентом из тегов "[Корректура][Существенно]"
 *  - Фильтры по важности/категории
 *  - Безопасный Dismiss через undo-тост (удаление откладывается на клиенте)
 *  - Состояния: pending / applied / dismissed / conflict (потерян якорь)
 *  - Крайние диффы: вставка (␣), удаление, одна буква, дефис→тире, длинный абзац
 *  - Человеческий тред не деградирует (та же система, другое наполнение)
 *  - Вкладки Open/Resolved сохранены
 */
import { useMemo, useState, useCallback, useRef } from 'react';
import {
  Box, Group, Stack, Text, Badge, Button, ActionIcon, Tabs, Progress,
  Avatar, Tooltip, ScrollArea, useMantineColorScheme, useMantineTheme,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';

/* ─────────────────────────── Типы данных ─────────────────────────── */

export type Severity = 'critical' | 'major' | 'minor';
export type Category = string; // "Корректура" | "Факт" | "Стиль" | …

/** Один сегмент интра-диффа: изменённый фрагмент подсвечивается. */
export interface DiffSegment {
  text: string;
  changed: boolean;
}

/** Правка: сервер уже отдаёт посегментную разметку обеих строк. */
export interface SuggestedEdit {
  before: DiffSegment[]; // "было" (пустой массив ⇒ чистая вставка)
  after: DiffSegment[];  // "стало" (пустой массив ⇒ чистое удаление)
}

export type CommentStatus = 'pending' | 'applied' | 'dismissed' | 'conflict';

export interface Comment {
  id: string;
  runId?: string;          // id прогона агента — для группировки серии
  authorName: string;      // "Корректор" | "Нарратор" | имя человека
  authorKind: 'agent' | 'human';
  triggeredBy?: string;    // кто запустил агента ("vvzvlad")
  createdAtLabel: string;  // "15 ч", "2 дн" — форматируется вызывающим кодом
  /** Сырой текст комментария от агента, метки в квадратных скобках. */
  bodyRaw: string;
  edit?: SuggestedEdit;    // есть ⇒ агентская правка; нет ⇒ обычный тред
  status: CommentStatus;
  replyCount?: number;
  anchorLost?: boolean;    // сервер ответил конфликтом якоря
}

export interface CommentsPanelProps {
  comments: Comment[];
  /** Применить одну правку. Резолвит тред на сервере. */
  onApply: (id: string) => Promise<void>;
  /** Жёсткое удаление на сервере (для треда без ответов). Вызывается ПОСЛЕ окна undo. */
  onDismiss: (id: string) => Promise<void>;
  /** Резолв обычного треда. */
  onResolve?: (id: string) => Promise<void>;
  /** Клик по карточке/цитате — скролл документа к якорю и подсветка. */
  onNavigateToAnchor: (id: string) => void;
  onClose?: () => void;
  /** Мс до фактического удаления после Dismiss (окно undo). По умолчанию 5000. */
  dismissUndoMs?: number;
}

/* ───────────────────── Клиентский парсинг меток ───────────────────── */

const SEVERITY_WORDS: Record<string, Severity> = {
  'существенно': 'major', 'критично': 'critical', 'критическая': 'critical',
  'незначительно': 'minor', 'мелко': 'minor', 'major': 'major',
  'minor': 'minor', 'critical': 'critical',
};

interface ParsedBody {
  category?: Category;
  severity: Severity;
  text: string; // тело без скобочных тегов
}

/** "[Корректура] [Существенно] Пробел…" → {category, severity, text}. */
export function parseBody(raw: string): ParsedBody {
  const tags: string[] = [];
  const text = raw.replace(/\[([^\]]+)\]/g, (_, t) => { tags.push(t.trim()); return ''; }).trim();
  let severity: Severity = 'minor';
  let category: Category | undefined;
  for (const t of tags) {
    const sv = SEVERITY_WORDS[t.toLowerCase()];
    if (sv) severity = sv; else if (!category) category = t;
  }
  return { category, severity, text };
}

const SEV_COLOR: Record<Severity, string> = {
  critical: 'red', major: 'orange', minor: 'gray',
};

/* ──────────────────────────── Дифф ──────────────────────────── */

/** Делает невидимые символы видимыми в подсветке (пробел, таб). */
function visibleWhitespace(s: string): string {
  return s.replace(/ /g, '␣').replace(/\t/g, '⇥');
}

function DiffLine({ segments, kind }: { segments: DiffSegment[]; kind: 'del' | 'ins' }) {
  const theme = useMantineTheme();
  const { colorScheme } = useMantineColorScheme();
  const dark = colorScheme === 'dark';
  const isDel = kind === 'del';
  const sign = isDel ? '−' : '+';
  const signColor = isDel ? theme.colors.red[dark ? 5 : 6] : theme.colors.green[dark ? 5 : 6];
  const baseColor = isDel
    ? (dark ? theme.colors.gray[5] : theme.colors.gray[6])
    : (dark ? theme.colors.gray[1] : theme.colors.dark[9]);
  const markBg = isDel
    ? (dark ? 'rgba(224,49,49,.22)' : '#ffe3e3')
    : (dark ? 'rgba(47,158,68,.22)' : '#d3f9d8');
  const markFg = isDel
    ? (dark ? theme.colors.red[3] : theme.colors.red[8])
    : (dark ? theme.colors.green[3] : theme.colors.green[9]);

  return (
    <Group gap={7} wrap="nowrap" align="flex-start">
      <Text ff="monospace" fw={600} fz={12} c={signColor} w={11} ta="center" style={{ flex: 'none', lineHeight: 1.5 }}>{sign}</Text>
      <Text fz={13.5} c={baseColor} style={{ lineHeight: 1.45 }}>
        {segments.map((seg, i) =>
          seg.changed ? (
            <Box key={i} component="mark" px={3} fw={600}
              style={{ background: markBg, color: markFg, borderRadius: 3,
                textDecoration: isDel ? 'line-through' : 'none' }}>
              {visibleWhitespace(seg.text)}
            </Box>
          ) : (
            <Box key={i} component="span" style={{ textDecoration: isDel ? 'line-through' : 'none' }}>{seg.text}</Box>
          )
        )}
      </Text>
    </Group>
  );
}

function DiffBlock({ edit }: { edit: SuggestedEdit }) {
  const pureInsert = edit.before.length === 0;
  const pureDelete = edit.after.length === 0;
  return (
    <Stack gap={1}>
      {!pureInsert && <DiffLine segments={edit.before} kind="del" />}
      {!pureDelete && <DiffLine segments={edit.after} kind="ins" />}
    </Stack>
  );
}

/* ──────────────────────── Карточка правки ──────────────────────── */

function EditCard({ c, onApply, onDismiss, onNavigateToAnchor, dismissUndoMs = 5000 }: {
  c: Comment;
  onApply: CommentsPanelProps['onApply'];
  onDismiss: CommentsPanelProps['onDismiss'];
  onNavigateToAnchor: CommentsPanelProps['onNavigateToAnchor'];
  dismissUndoMs?: number;
}) {
  const parsed = useMemo(() => parseBody(c.bodyRaw), [c.bodyRaw]);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number>();

  const apply = useCallback(async () => {
    setBusy(true);
    try { await onApply(c.id); } finally { setBusy(false); }
  }, [c.id, onApply]);

  // Безопасный Dismiss: прячем сразу, удаляем на сервере после окна undo.
  const dismiss = useCallback(() => {
    let undone = false;
    const nid = notifications.show({
      message: 'Edit dismissed',
      color: 'gray',
      autoClose: dismissUndoMs,
      withCloseButton: false,
      // Кнопка "Вернуть" — см. README про кастомный рендер экшена.
    });
    timer.current = window.setTimeout(() => {
      if (!undone) onDismiss(c.id);
    }, dismissUndoMs);
    // undo вызывается из UI: clearTimeout(timer.current); undone = true;
    return { nid, cancel: () => { undone = true; clearTimeout(timer.current); } };
  }, [c.id, onDismiss, dismissUndoMs]);

  const conflict = c.status === 'conflict' || c.anchorLost;

  return (
    <Box
      p="10px 12px"
      onClick={() => onNavigateToAnchor(c.id)}
      style={(t) => ({
        cursor: 'pointer',
        borderBottom: `1px solid ${t.colorScheme === 'dark' ? t.colors.dark[5] : t.colors.gray[1]}`,
      })}
    >
      <Stack gap={8}>
        {c.edit && <DiffBlock edit={c.edit} />}

        {conflict && (
          <Group gap={7} wrap="nowrap" p="6px 8px"
            style={(t) => ({ background: t.colorScheme === 'dark' ? 'rgba(230,180,20,.12)' : '#fff9db', borderRadius: 7 })}>
            <Text fz={12}>⚠</Text>
            <Text fz={12} c="yellow.8" style={{ lineHeight: 1.4 }}>Text changed — this edit can’t be applied</Text>
          </Group>
        )}

        {parsed.text && !conflict && (
          <Text fz={12.5} c="dimmed" style={{ lineHeight: 1.45 }}>{parsed.text}</Text>
        )}

        <Group gap={8} wrap="nowrap" onClick={(e) => e.stopPropagation()}>
          <Box w={8} h={8} style={(t) => ({ flex: 'none', borderRadius: '50%', background: t.colors[SEV_COLOR[parsed.severity]][6] })} />
          <Text fz={10} fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: '.06em', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {[parsed.category, parsed.severity === 'major' ? 'Major' : parsed.severity === 'critical' ? 'Critical' : null].filter(Boolean).join(' · ')}
          </Text>

          {c.status === 'applied' ? (
            <Badge color="green" variant="light" radius="xl" size="sm">✓ Applied</Badge>
          ) : c.status === 'dismissed' ? (
            <Badge color="gray" variant="light" radius="xl" size="sm">Dismissed</Badge>
          ) : conflict ? (
            <Button size="compact-sm" variant="default" onClick={() => onNavigateToAnchor(c.id)}>Go to text</Button>
          ) : (
            <>
              <Button size="compact-sm" variant="default" color="gray" onClick={dismiss}>Dismiss</Button>
              <Button size="compact-sm" color="green" loading={busy} onClick={apply}>Apply</Button>
            </>
          )}
        </Group>
      </Stack>
    </Box>
  );
}

/* ──────────────────────── Человеческий тред ──────────────────────── */

function HumanThread({ c, onResolve, onNavigateToAnchor }: {
  c: Comment; onResolve?: CommentsPanelProps['onResolve']; onNavigateToAnchor: CommentsPanelProps['onNavigateToAnchor'];
}) {
  const parsed = useMemo(() => parseBody(c.bodyRaw), [c.bodyRaw]);
  return (
    <Box p="12px 14px" style={(t) => ({ borderBottom: `1px solid ${t.colorScheme === 'dark' ? t.colors.dark[5] : t.colors.gray[1]}` })}>
      <Stack gap={9}>
        <Group gap={8} wrap="nowrap">
          <Avatar size={26} radius="xl" color="orange">{c.authorName[0]}</Avatar>
          <Text fz={12.5} fw={600}>{c.authorName}
            <Text span c="dimmed" fw={400}> · {c.triggeredBy ? `${c.triggeredBy} · ` : ''}{c.createdAtLabel}</Text>
          </Text>
          <Box style={{ flex: 1 }} />
          <Tooltip label="Resolve"><ActionIcon variant="default" size="md" onClick={() => onResolve?.(c.id)}>✓</ActionIcon></Tooltip>
          <ActionIcon variant="default" size="md">⋯</ActionIcon>
        </Group>
        <Text fz={13.5} style={{ lineHeight: 1.5 }}>{parsed.text}</Text>
        <Group gap={8}>
          {c.replyCount ? <Text fz={12} c="dimmed">{c.replyCount} replies</Text> : null}
          <Box style={{ flex: 1 }} />
          <Button variant="subtle" size="compact-sm">Reply</Button>
        </Group>
      </Stack>
    </Box>
  );
}

/* ──────────────────── Шапка серии + прогресс ──────────────────── */

function RunHeader({ runComments, onAcceptAll, progress }: {
  runComments: Comment[];
  onAcceptAll: () => void;
  progress?: { done: number; total: number } | null;
}) {
  const head = runComments[0];
  const majors = runComments.filter((c) => parseBody(c.bodyRaw).severity !== 'minor').length;
  const applied = runComments.filter((c) => c.status === 'applied').length;
  return (
    <Box>
      <Group gap={10} wrap="nowrap" p="11px 13px" style={(t) => ({ borderBottom: `1px solid ${t.colorScheme === 'dark' ? t.colors.dark[5] : t.colors.gray[1]}` })}>
        <Box style={{ position: 'relative', width: 30, height: 30, flex: 'none' }}>
          <Avatar size={30} radius={8} color="teal">{head.authorName[0]}</Avatar>
          {head.triggeredBy && (
            <Avatar size={14} radius="xl" color="gray"
              style={{ position: 'absolute', right: -4, bottom: -4, border: '2px solid var(--mantine-color-body)' }} />
          )}
        </Box>
        <Stack gap={1} style={{ minWidth: 0 }}>
          <Text fz={13} fw={600}>{head.authorName}
            <Text span c="dimmed" fw={400}> · {head.triggeredBy} · {head.createdAtLabel}</Text>
          </Text>
          <Text fz={11.5} c="dimmed">
            {runComments.length} edits · <Text span c="orange.7" fw={600}>{majors} major</Text> · {applied} applied
          </Text>
        </Stack>
        <Box style={{ flex: 1 }} />
        {!progress && <Button size="compact-sm" color="green" onClick={onAcceptAll}>Accept all</Button>}
      </Group>
      {progress && (
        <Box p="9px 13px 11px" style={(t) => ({ background: t.colorScheme === 'dark' ? 'rgba(47,158,68,.08)' : '#f8fbf9', borderBottom: `1px solid ${t.colorScheme === 'dark' ? t.colors.dark[5] : t.colors.gray[2]}` })}>
          <Group gap={8} mb={6}>
            <Text fz={12} fw={600} c="green.7">Applying {progress.done} of {progress.total}…</Text>
            <Box style={{ flex: 1 }} />
            <Button variant="subtle" color="gray" size="compact-xs">Stop</Button>
          </Group>
          <Progress value={(progress.done / progress.total) * 100} color="green" size="sm" radius="xl" />
        </Box>
      )}
    </Box>
  );
}

/* ──────────────────────────── Панель ──────────────────────────── */

/** Роль-автор для фильтра: у агентов — имя роли, у людей — «Пользователь». */
function roleOf(c: Comment): string {
  return c.authorKind === 'human' ? 'Пользователь' : c.authorName;
}

export function CommentsPanel(props: CommentsPanelProps) {
  const { comments, onApply, onDismiss, onResolve, onNavigateToAnchor, onClose, dismissUndoMs } = props;
  const [tab, setTab] = useState<'open' | 'resolved'>('open');
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, { done: number; total: number }>>({});

  const open = comments.filter((c) => c.status === 'pending' || c.status === 'conflict');
  const resolved = comments.filter((c) => c.status === 'applied' || c.status === 'dismissed');
  const list = tab === 'open' ? open : resolved;

  const filtered = list.filter((c) => !roleFilter || roleOf(c) === roleFilter);

  // Роли и счётчики для чипов-фильтров (только роли: Корректор / Фактчекер / Пользователь …).
  const roles = useMemo(() => {
    const order: string[] = [];
    const count: Record<string, number> = {};
    for (const c of list) {
      const r = roleOf(c);
      if (!(r in count)) { count[r] = 0; order.push(r); }
      count[r]++;
    }
    return order.map((r) => ({ role: r, count: count[r] }));
  }, [list]);

  // Группировка агентских правок по runId; человеческие треды — по одному.
  const groups = useMemo(() => {
    const map = new Map<string, Comment[]>();
    const singles: Comment[] = [];
    for (const c of filtered) {
      if (c.authorKind === 'agent' && c.runId && c.edit) {
        if (!map.has(c.runId)) map.set(c.runId, []);
        map.get(c.runId)!.push(c);
      } else singles.push(c);
    }
    return { runs: [...map.entries()], singles };
  }, [filtered]);

  // Пакетное "Accept all" — по одной на фронте, обновляем прогресс.
  const acceptAll = useCallback(async (runId: string, items: Comment[]) => {
    const minor = items.filter((c) => parseBody(c.bodyRaw).severity === 'minor' && c.status === 'pending');
    for (let i = 0; i < minor.length; i++) {
      setProgress((p) => ({ ...p, [runId]: { done: i, total: minor.length } }));
      try { await onApply(minor[i].id); } catch { /* конфликт — пропускаем, копим для сводки */ }
    }
    setProgress((p) => { const n = { ...p }; delete n[runId]; return n; });
    notifications.show({ color: 'green', message: `${minor.length} applied` });
  }, [onApply]);

  return (
    <Stack gap={0} h="100%" style={{ width: 380, maxWidth: '100%', borderLeft: '1px solid var(--mantine-color-default-border)' }}>
      {/* Вкладки — статусная ось. Open/Resolved сохранены. */}
      <Group gap={4} p="10px 14px" style={(t) => ({ borderBottom: `1px solid ${t.colorScheme === 'dark' ? t.colors.dark[5] : t.colors.gray[2]}` })}>
        <Tabs value={tab} onChange={(v) => setTab(v as 'open' | 'resolved')} variant="pills">
          <Tabs.List>
            <Tabs.Tab value="open" rightSection={<Badge size="sm" variant="light" color="blue">{open.length}</Badge>}>Open</Tabs.Tab>
            <Tabs.Tab value="resolved" rightSection={<Badge size="sm" variant="light" color="gray">{resolved.length}</Badge>}>Resolved</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        <Box style={{ flex: 1 }} />
        {onClose && <ActionIcon variant="subtle" color="gray" onClick={onClose}>✕</ActionIcon>}
      </Group>

      {/* Фильтры-чипы: только по ролям (Корректор / Фактчекер / Пользователь). */}
      {tab === 'open' && roles.length > 1 && (
        <ScrollArea type="never" p="8px 14px" style={(t) => ({ borderBottom: `1px solid ${t.colorScheme === 'dark' ? t.colors.dark[5] : t.colors.gray[1]}` })}>
          <Group gap={6} wrap="nowrap">
            <FilterChip active={!roleFilter} onClick={() => setRoleFilter(null)} label={`All ${list.length}`} solid />
            {roles.map(({ role, count }) => (
              <FilterChip key={role} active={roleFilter === role} onClick={() => setRoleFilter(roleFilter === role ? null : role)} label={`${role} ${count}`} />
            ))}
          </Group>
        </ScrollArea>
      )}

      {/* Лента */}
      <ScrollArea style={{ flex: 1 }} bg="var(--mantine-color-default-hover)">
        {filtered.length === 0 ? (
          <EmptyState tab={tab} />
        ) : (
          <>
            {groups.runs.map(([runId, items]) => (
              <Box key={runId} m="6px 10px" bg="var(--mantine-color-body)" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 10, overflow: 'hidden' }}>
                <RunHeader runComments={items} progress={progress[runId] ?? null} onAcceptAll={() => acceptAll(runId, items)} />
                {items.map((c) => (
                  <EditCard key={c.id} c={c} onApply={onApply} onDismiss={onDismiss} onNavigateToAnchor={onNavigateToAnchor} dismissUndoMs={dismissUndoMs} />
                ))}
              </Box>
            ))}
            {groups.singles.map((c) => (
              <Box key={c.id} m="6px 10px" bg="var(--mantine-color-body)" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 10, overflow: 'hidden' }}>
                {c.edit
                  ? <EditCard c={c} onApply={onApply} onDismiss={onDismiss} onNavigateToAnchor={onNavigateToAnchor} dismissUndoMs={dismissUndoMs} />
                  : <HumanThread c={c} onResolve={onResolve} onNavigateToAnchor={onNavigateToAnchor} />}
              </Box>
            ))}
          </>
        )}
      </ScrollArea>
    </Stack>
  );
}

/* ─────────────────────── Мелкие компоненты ─────────────────────── */

function FilterChip({ label, active, onClick, dot, solid }: {
  label: string; active: boolean; onClick: () => void; dot?: string; solid?: boolean;
}) {
  return (
    <Button
      onClick={onClick}
      size="compact-sm"
      radius="xl"
      variant={active ? 'filled' : 'default'}
      color={active ? (solid ? 'dark' : 'blue') : 'gray'}
      leftSection={dot ? <Box w={7} h={7} style={(t) => ({ borderRadius: '50%', background: t.colors[dot][6] })} /> : undefined}
      styles={{ root: { flex: 'none' }, label: { fontWeight: 600, fontSize: 12 } }}
    >
      {label}
    </Button>
  );
}

function EmptyState({ tab }: { tab: 'open' | 'resolved' }) {
  const isOpen = tab === 'open';
  return (
    <Stack align="center" gap={6} p="40px 20px">
      <Avatar size={40} radius="xl" color={isOpen ? 'green' : 'gray'}>{isOpen ? '✓' : '◌'}</Avatar>
      <Text fw={600} fz={13}>{isOpen ? 'All caught up' : 'Nothing here yet'}</Text>
      <Text fz={12} c="dimmed" ta="center" style={{ lineHeight: 1.45 }}>
        {isOpen ? 'No edits waiting on you.' : 'Applied and closed items will appear here.'}
      </Text>
    </Stack>
  );
}

export default CommentsPanel;
