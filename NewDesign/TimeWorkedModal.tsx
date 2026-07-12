/**
 * TimeWorkedModal — редизайн окна «Time worked on this article».
 * Mantine v7. Light/dark.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ЧТО ЭТО
 * ─────────────────────────────────────────────────────────────────────────
 * Сводка трудозатрат по дням в виде суточных таймлайнов. Главное отличие от
 * старой версии: на барах ВИДНО время суток. Реализовано двумя способами
 * (проп `axis`):
 *   - 'grid'   — ось часов 00–06–12–18–24 сверху + вертикальные деления,
 *                ночные часы (0–6, 21–24) слегка затемнены. По умолчанию.
 *   - 'phases' — цветные полосы фаз дня за блоками (Ночь/Утро/День/Вечер),
 *                период суток читается сразу, без счёта делений.
 *
 * Блоки позиционируются по времени: left = start/24, width = dur/24.
 * Интенсивность (opacity) блока = длительность/плотность работы, чтобы
 * очень короткие сессии не терялись (минимальная видимая ширина задана).
 * Hover-тултип на блоке: начало–конец · длительность.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * УСТАНОВКА / ИСПОЛЬЗОВАНИЕ
 * ─────────────────────────────────────────────────────────────────────────
 *   import { TimeWorkedModal, DaySummary } from './TimeWorkedModal';
 *
 *   <TimeWorkedModal
 *     opened={open}
 *     onClose={() => setOpen(false)}
 *     totalLabel="≈ 34h"
 *     agentLabel="≈ 1h 20m"          // undefined → строку agent не показываем
 *     days={days}                     // DaySummary[]
 *     axis="grid"                     // 'grid' | 'phases'
 *     tz="Europe/Moscow"
 *     inactivityGapMin={15}
 *   />
 *
 * Требует MantineProvider на корне.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ФОРМАТ ДАННЫХ
 * ─────────────────────────────────────────────────────────────────────────
 *   interface Block {
 *     start: number;   // час начала в сутках, 0..24 (напр. 13.7 = 13:42)
 *     end: number;     // час конца
 *     kind: 'work' | 'agent';
 *   }
 *   interface DaySummary {
 *     label: string;       // «Mon 29 Jun»
 *     totalLabel: string;  // «1h 24m» | «—» для пустого дня
 *     blocks: Block[];     // [] → пустой день (полупрозрачная дорожка, итог «—»)
 *     isToday?: boolean;   // сегодня — неполные сутки (рисуем границу «сейчас»)
 *     nowFraction?: number;// 0..1 позиция «сейчас» для isToday
 *   }
 *
 * Данные уже есть в бэкенде трудозатрат: сессии с началом/концом + тип
 * (work/agent). Часы = локальные к tz. Изменений API не требуется.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * СОСТОЯНИЯ (нарисованы/поддержаны)
 * ─────────────────────────────────────────────────────────────────────────
 *  - День: с активностью (work+agent) / только work / только agent / пустой (—).
 *  - Сегодня: граница «сейчас» на дорожке (nowFraction).
 *  - Короткий блок: минимальная ширина, не исчезает.
 *  - Пустая панель целиком: нет трудозатрат → EmptyState.
 *  - Длинный период: вертикальный скролл списка дней, шапка/легенда липкие.
 *  - Тёмная тема: токены Mantine.
 */
import { Modal, Box, Group, Stack, Text, ActionIcon, ScrollArea, Tooltip, useMantineColorScheme } from '@mantine/core';

/* ─────────────────────────── Типы ─────────────────────────── */

export interface Block { start: number; end: number; kind: 'work' | 'agent'; }
export interface DaySummary {
  label: string;
  totalLabel: string;
  blocks: Block[];
  isToday?: boolean;
  nowFraction?: number;
}
export interface TimeWorkedModalProps {
  opened: boolean;
  onClose: () => void;
  totalLabel: string;
  agentLabel?: string;
  days: DaySummary[];
  axis?: 'grid' | 'phases';
  tz?: string;
  inactivityGapMin?: number;
}

const WORK = '#3b82f6';
const AGENT = '#c026d3';

const PHASES = [
  { name: 'Ночь', s: 0, e: 6, bg: 'rgba(99,102,241,.10)', lg: '#e8eaff', fg: '#5b60c9' },
  { name: 'Утро', s: 6, e: 12, bg: 'rgba(245,159,0,.10)', lg: '#fff2dc', fg: '#b5820e' },
  { name: 'День', s: 12, e: 18, bg: 'rgba(56,178,172,.10)', lg: '#dcf5f2', fg: '#1a857d' },
  { name: 'Вечер', s: 18, e: 24, bg: 'rgba(139,92,246,.11)', lg: '#efe7ff', fg: '#6d43c0' },
];

/* ─────────────────────────── Блок активности ─────────────────────────── */

function fmtHour(h: number) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
function fmtDur(h: number) {
  const total = Math.round(h * 60);
  const hh = Math.floor(total / 60), mm = total % 60;
  return hh ? `${hh}h ${mm}m` : `${mm}m`;
}

function ActivityBlock({ b }: { b: Block }) {
  const left = (b.start / 24) * 100;
  const width = Math.max(((b.end - b.start) / 24) * 100, 0.6);
  const dur = b.end - b.start;
  const opacity = dur < 0.16 ? 0.5 : dur < 0.35 ? 0.8 : 1;
  return (
    <Tooltip label={`${fmtHour(b.start)} – ${fmtHour(b.end)} · ${fmtDur(dur)}`} withArrow openDelay={120} fz={11}>
      <Box style={{
        position: 'absolute', top: 5, height: 14, left: `${left}%`, width: `${width}%`,
        borderRadius: 2, background: b.kind === 'agent' ? AGENT : WORK, opacity, cursor: 'default',
      }} />
    </Tooltip>
  );
}

/* ─────────────────────────── Дорожка дня ─────────────────────────── */

function DayTrack({ d, axis, dark }: { d: DaySummary; axis: 'grid' | 'phases'; dark: boolean }) {
  const trackBg = axis === 'grid'
    ? 'linear-gradient(90deg, rgba(90,100,130,.10) 0 25%, rgba(90,100,130,.02) 25% 87.5%, rgba(90,100,130,.10) 87.5% 100%)'
    : (dark ? 'rgba(255,255,255,.04)' : '#f6f8fa');

  return (
    <Group gap={0} h={30} wrap="nowrap">
      <Text style={{ flex: 'none', width: 92 }} fz={13} c="dimmed">{d.label}</Text>
      <Box style={{ position: 'relative', flex: 1, height: 24, margin: '0 4px', borderRadius: 5, overflow: 'hidden', background: trackBg }}>
        {/* фон: полосы фаз или деления сетки */}
        {axis === 'phases'
          ? PHASES.map((ph) => (
              <Box key={ph.name} style={{ position: 'absolute', top: 0, bottom: 0, left: `${(ph.s / 24) * 100}%`, width: `${((ph.e - ph.s) / 24) * 100}%`, background: ph.bg }} />
            ))
          : [25, 50, 75].map((p) => (
              <Box key={p} style={{ position: 'absolute', top: 0, bottom: 0, left: `${p}%`, width: 1, background: 'rgba(120,130,150,.16)' }} />
            ))}
        {/* блоки */}
        {d.blocks.map((b, i) => <ActivityBlock key={i} b={b} />)}
        {/* граница «сейчас» для сегодняшнего дня */}
        {d.isToday && d.nowFraction != null && (
          <Box style={{ position: 'absolute', top: 0, bottom: 0, left: `${d.nowFraction * 100}%`, width: 2, background: '#fa5252' }} />
        )}
      </Box>
      <Text style={{ flex: 'none', width: 64, textAlign: 'right' }} fz={12.5} fw={500} c={d.totalLabel === '—' ? 'dimmed' : undefined}>
        {d.totalLabel}
      </Text>
    </Group>
  );
}

/* ─────────────────────────── Окно ─────────────────────────── */

export function TimeWorkedModal(props: TimeWorkedModalProps) {
  const { opened, onClose, totalLabel, agentLabel, days, axis = 'grid', tz = 'Europe/Moscow', inactivityGapMin = 15 } = props;
  const { colorScheme } = useMantineColorScheme();
  const dark = colorScheme === 'dark';
  const isEmpty = days.length === 0 || days.every((d) => d.blocks.length === 0);

  return (
    <Modal opened={opened} onClose={onClose} withCloseButton={false} size="46rem" radius="lg" padding={0}
      overlayProps={{ backgroundOpacity: 0.5, blur: 1 }}>
      <Box p="22px 24px 20px">
        {/* header */}
        <Group mb={14}>
          <Text fz={17} fw={600}>Time worked on this article</Text>
          <Box style={{ flex: 1 }} />
          <ActionIcon variant="subtle" color="gray" size="lg" onClick={onClose}>✕</ActionIcon>
        </Group>

        {/* summary */}
        <Group align="baseline" gap={16} mb={axis === 'grid' ? 8 : 16}>
          <Text fz={22} fw={700}>{totalLabel}</Text>
          {agentLabel && <Text fz={13} c="dimmed">agent: {agentLabel}</Text>}
        </Group>

        {/* legend (grid only) */}
        {axis === 'grid' && (
          <Group gap={16} mb={16}>
            <Group gap={6}><Box w={12} h={12} style={{ borderRadius: 3, background: WORK }} /><Text fz={12} fw={500} c="dimmed">Work</Text></Group>
            <Group gap={6}><Box w={12} h={12} style={{ borderRadius: 3, background: AGENT }} /><Text fz={12} fw={500} c="dimmed">Agent</Text></Group>
          </Group>
        )}

        {isEmpty ? (
          <Stack align="center" gap={6} p="48px 20px">
            <Text fw={600} fz={14}>No time tracked yet</Text>
            <Text fz={12.5} c="dimmed" ta="center">По этой статье ещё нет трудозатрат.</Text>
          </Stack>
        ) : (
          <>
            {/* axis header (sticky) */}
            <Group gap={0} mb={5} wrap="nowrap" style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--mantine-color-body)' }}>
              <Box style={{ flex: 'none', width: 92 }} />
              {axis === 'grid' ? (
                <Box style={{ flex: 1, position: 'relative', height: 14, margin: '0 4px' }}>
                  {[['0%', '00', 'flex-start'], ['25%', '06', 'center'], ['50%', '12', 'center'], ['75%', '18', 'center'], ['100%', '24', 'flex-end']].map(([l, t, al]) => (
                    <Text key={t as string} fz={10} fw={500} c="dimmed" style={{ position: 'absolute', left: l as string, transform: al === 'center' ? 'translateX(-50%)' : al === 'flex-end' ? 'translateX(-100%)' : undefined }}>{t}</Text>
                  ))}
                </Box>
              ) : (
                <Box style={{ flex: 1, display: 'flex', height: 16, margin: '0 4px', borderRadius: 4, overflow: 'hidden' }}>
                  {PHASES.map((ph) => (
                    <Box key={ph.name} style={{ flex: ph.e - ph.s, display: 'flex', alignItems: 'center', justifyContent: 'center', background: ph.lg, color: ph.fg, font: '600 9.5px system-ui' }}>{ph.name}</Box>
                  ))}
                </Box>
              )}
              <Box style={{ flex: 'none', width: 64 }} />
            </Group>

            {/* day rows */}
            <ScrollArea.Autosize mah="60vh" type="hover">
              {days.map((d, i) => <DayTrack key={i} d={d} axis={axis} dark={dark} />)}
            </ScrollArea.Autosize>
          </>
        )}

        <Text mt={16} fz={11.5} c="dimmed">Estimate · timezone {tz} · inactivity gap {inactivityGapMin} min</Text>
      </Box>
    </Modal>
  );
}

export default TimeWorkedModal;
