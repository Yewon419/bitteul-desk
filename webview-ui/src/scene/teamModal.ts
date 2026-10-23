/**
 * "새 팀" dialog: compose a team (MD plus members, a model each), optionally from a saved
 * template, then hand it to a new chat window where the user writes the first brief.
 */

import {
  fetchJson,
  postJson,
  saveTeamDraft,
  type TeamRoster,
  type TeamTemplatesResponse,
} from './api.js';

const MODELS: Array<[string, string]> = [
  ['opus', 'Opus · 깊게'],
  ['sonnet', 'Sonnet · 균형'],
  ['haiku', 'Haiku · 빠름·저렴'],
];
const MAX_MEMBERS = 8;
/** Front-facing staff sprites in the office, one per palette. */
const STAFF_VARIANTS = 6;
const NEW_MEMBER_ROLE = '';

export interface TeamRoomPick {
  /** Desks for the team, MD first. */
  seats: number[];
  /** Rooms those desks are in; their signs take the team name. */
  rooms: number[];
}

interface Options {
  token: string;
  /** Free desks for this many people, in rooms nobody else uses. */
  pickRoom: (people: number) => TeamRoomPick;
  /** Open the chat window that starts the drafted team. */
  open: (draftId: string, leadSeat: number | undefined) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function modelSelect(value: string): HTMLSelectElement {
  const select = el('select', { className: 'team-model' });
  select.append(...MODELS.map(([v, label]) => new Option(label, v)));
  select.value = value;
  return select;
}

function copyTeam(team: TeamRoster): TeamRoster {
  return { ...team, members: team.members.map((m) => ({ ...m })) };
}

/** Wire the dialog; returns the function that opens it. */
export function initTeamModal(opts: Options): () => void {
  const modal = document.getElementById('team-modal');
  const form = document.getElementById('team-form') as HTMLFormElement | null;
  const list = document.getElementById('team-members');
  const errorEl = document.getElementById('team-error');
  const templateSelect = document.getElementById('team-template') as HTMLSelectElement | null;
  const deleteBtn = document.getElementById('team-template-delete') as HTMLButtonElement | null;
  const nameInput = document.getElementById('team-name') as HTMLInputElement | null;
  const cwdInput = document.getElementById('team-cwd') as HTMLInputElement | null;
  const budgetInput = document.getElementById('team-budget') as HTMLInputElement | null;
  const leadSlot = document.getElementById('team-lead');
  const editor = document.getElementById('team-editor');
  const countEl = document.getElementById('team-count');
  if (
    !modal ||
    !form ||
    !list ||
    !errorEl ||
    !templateSelect ||
    !deleteBtn ||
    !nameInput ||
    !cwdInput ||
    !budgetInput ||
    !leadSlot ||
    !editor
  ) {
    throw new Error('[Scene] team dialog markup missing');
  }

  let defaultTeam: TeamRoster | null = null;
  let templates: TeamRoster[] = [];
  let team: TeamRoster | null = null;

  const say = (message: string, ok = false): void => {
    errorEl.textContent = message;
    if (ok) errorEl.dataset.ok = '1';
    else delete errorEl.dataset.ok;
  };

  const close = (): void => {
    modal.hidden = true;
  };

  /** The person being edited: 0 is the MD, then members by position; null when none. */
  let selected: number | null = null;
  /** The cards on screen by person, so typing in the editor updates just that card. */
  let cards: HTMLElement[] = [];

  const face = (person: number): HTMLImageElement => {
    const img = el('img', {
      className: 'tm-face',
      alt: '',
      src: `./scene/staff/front_${person % STAFF_VARIANTS}_a.png`,
    });
    img.setAttribute('aria-hidden', 'true');
    return img;
  };

  const modelLabel = (model: string): string => MODELS.find(([v]) => v === model)?.[1] ?? model;

  const select = (person: number | null): void => {
    selected = person;
    render();
    if (person !== null) editor.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const cardFor = (t: TeamRoster, person: number): HTMLElement => {
    const lead = person === 0;
    const m = lead ? null : t.members[person - 1];
    const name = (lead ? t.leadLabel : (m?.label ?? '')).trim();
    const role = lead ? '팀장' : (m?.role ?? '').trim() || '맡을 일을 적어 주세요';
    const btn = el(
      'button',
      { type: 'button', className: 'tm-person' },
      face(person),
      el('span', { className: 'tm-person-name' }, name || '이름 없음'),
      el('span', { className: 'tm-person-role' }, role),
      el(
        'span',
        { className: 'tm-person-model' },
        modelLabel(lead ? t.leadModel : (m?.model ?? '')),
      ),
    );
    if (selected === person) btn.dataset.selected = '1';
    if (lead) btn.dataset.lead = '1';
    if (!name || (m && !m.role.trim())) btn.dataset.missing = '1';
    btn.setAttribute('aria-pressed', String(selected === person));
    btn.addEventListener('click', () => select(selected === person ? null : person));
    return btn;
  };

  const refreshCard = (person: number): void => {
    if (!team || !cards[person]) return;
    const fresh = cardFor(team, person);
    cards[person].replaceWith(fresh);
    cards[person] = fresh;
  };

  const addMember = (): void => {
    if (!team || team.members.length >= MAX_MEMBERS) return;
    const taken = new Set(team.members.map((m) => m.key));
    let n = 1;
    while (taken.has(`member-${n}`)) n++;
    team.members.push({ key: `member-${n}`, label: '', role: NEW_MEMBER_ROLE, model: 'sonnet' });
    select(team.members.length);
    editor.querySelector<HTMLInputElement>('input')?.focus();
  };

  const editorFor = (t: TeamRoster, person: number): HTMLElement => {
    const lead = person === 0;
    const m = lead ? null : t.members[person - 1];
    const label = el('input', {
      value: lead ? t.leadLabel : (m?.label ?? ''),
      maxLength: 20,
      placeholder: lead ? '예: MD' : '예: 마케터',
    });
    label.addEventListener('input', () => {
      if (m) m.label = label.value;
      else t.leadLabel = label.value;
      refreshCard(person);
    });
    const model = modelSelect(lead ? t.leadModel : (m?.model ?? 'sonnet'));
    model.addEventListener('change', () => {
      if (m) m.model = model.value;
      else t.leadModel = model.value;
      refreshCard(person);
    });
    const done = el('button', { type: 'button', className: 'tm-icon-btn' }, '✕');
    done.setAttribute('aria-label', '고치기 닫기');
    done.addEventListener('click', () => select(null));
    const box = el(
      'div',
      { className: 'tm-editor' },
      el(
        'div',
        { className: 'tm-editor-head' },
        face(person),
        el('h4', {}, lead ? '팀장' : '팀원'),
        done,
      ),
      el(
        'div',
        { className: 'tm-fields' },
        el('label', {}, '이름', label),
        el('label', {}, '모델', model),
      ),
    );
    if (!m) {
      box.append(
        el(
          'p',
          { className: 'team-lead-note' },
          '대표님 지시를 받아 팀원에게 일을 나누고, 결과를 확인해서 보고해요.',
        ),
      );
      return box;
    }
    const role = el('textarea', {
      value: m.role,
      maxLength: 500,
      rows: 3,
      placeholder: '한 줄로: 이 사람이 맡을 일',
    });
    role.addEventListener('input', () => {
      m.role = role.value;
      refreshCard(person);
    });
    const remove = el(
      'button',
      { type: 'button', className: 'tm-text-btn team-remove' },
      '이 팀원 빼기',
    );
    remove.addEventListener('click', () => {
      t.members.splice(person - 1, 1);
      select(null);
    });
    box.append(
      el('label', {}, '맡을 일', role),
      el('div', { className: 'tm-row-foot' }, el('span', {}), remove),
    );
    return box;
  };

  function render(): void {
    if (!team) return;
    const t = team;
    if (selected !== null && selected > t.members.length) selected = null;
    cards = [cardFor(t, 0), ...t.members.map((_, i) => cardFor(t, i + 1))];
    leadSlot?.replaceChildren(cards[0]);
    const add = el(
      'button',
      { type: 'button', className: 'tm-person tm-add', disabled: t.members.length >= MAX_MEMBERS },
      el('span', { className: 'tm-plus' }, '+'),
      el('span', {}, t.members.length >= MAX_MEMBERS ? `최대 ${MAX_MEMBERS}명` : '팀원 추가'),
    );
    add.addEventListener('click', addMember);
    list?.replaceChildren(...cards.slice(1).map((c) => el('li', {}, c)), el('li', {}, add));
    editor?.replaceChildren(...(selected === null ? [] : [editorFor(t, selected)]));
    if (countEl) countEl.textContent = `${t.members.length + 1}명`;
  }

  const renderTemplates = (selected: string): void => {
    templateSelect.replaceChildren(
      new Option('기본 팀', ''),
      ...templates.map((t) => new Option(t.name, t.name)),
    );
    templateSelect.value = selected;
    deleteBtn.hidden = !selected;
  };

  const useTemplate = (name: string): void => {
    const source = templates.find((t) => t.name === name) ?? defaultTeam;
    if (!source) return;
    team = copyTeam(source);
    nameInput.value = name ? source.name : '';
    cwdInput.value = source.cwd ?? '';
    budgetInput.value = source.budgetUsd === undefined ? '' : String(source.budgetUsd);
    deleteBtn.hidden = !name;
    selected = null;
    say('');
    render();
  };

  /** The dialog's team as the server takes it, or a reason it cannot go yet. */
  const collect = (): TeamRoster | string => {
    if (!team) return '팀 정보를 아직 못 불러왔어요.';
    const name = nameInput.value.trim();
    if (!name) return '팀 이름을 적어 주세요. 사무실 방 팻말에 이 이름이 붙어요.';
    if (!team.leadLabel.trim()) {
      select(0);
      return '팀장 이름을 적어 주세요.';
    }
    if (team.members.length === 0) return '팀원이 한 명은 있어야 해요.';
    const blank = team.members.find((m) => !m.label.trim() || !m.role.trim());
    if (blank) {
      select(team.members.indexOf(blank) + 1);
      return '팀원마다 이름과 맡을 일을 적어 주세요.';
    }
    const cwd = cwdInput.value.trim();
    const budgetText = budgetInput.value.trim();
    const budgetUsd = budgetText ? Number(budgetText) : undefined;
    if (budgetUsd !== undefined && !(budgetUsd > 0 && budgetUsd <= 1000)) {
      return '예산은 0보다 크고 1000달러 이하로 적어 주세요. 한도 없이 하려면 비워 두세요.';
    }
    // The inputs decide these; a template's own values must not ride along when cleared.
    const { cwd: _cwd, budgetUsd: _budget, ...rest } = team;
    void _cwd;
    void _budget;
    return {
      ...rest,
      name,
      leadLabel: team.leadLabel.trim(),
      members: team.members.map((m) => ({ ...m, label: m.label.trim(), role: m.role.trim() })),
      ...(cwd ? { cwd } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    };
  };

  templateSelect.addEventListener('change', () => useTemplate(templateSelect.value));

  deleteBtn.addEventListener('click', () => {
    const name = templateSelect.value;
    if (!name) return;
    if (deleteBtn.dataset.confirm !== '1') {
      deleteBtn.dataset.confirm = '1';
      deleteBtn.textContent = '한 번 더 누르면 삭제';
      return;
    }
    delete deleteBtn.dataset.confirm;
    deleteBtn.textContent = '템플릿 삭제';
    void fetch(`./api/dashboard/team-templates/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${opts.token}` },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        templates = templates.filter((t) => t.name !== name);
        renderTemplates('');
        useTemplate('');
      })
      .catch((err: unknown) => {
        say(`템플릿을 지우지 못했어요: ${String(err)}`);
      });
  });

  document.getElementById('team-save')?.addEventListener('click', () => {
    const draft = collect();
    if (typeof draft === 'string') {
      say(draft);
      return;
    }
    postJson('./api/dashboard/team-templates', opts.token, { team: draft })
      .then(() => {
        templates = [...templates.filter((t) => t.name !== draft.name), copyTeam(draft)];
        renderTemplates(draft.name);
        say(`"${draft.name}" 템플릿으로 저장했어요.`, true);
      })
      .catch((err: unknown) => {
        say(`저장하지 못했어요: ${String(err)}`);
      });
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const draft = collect();
    if (typeof draft === 'string') {
      say(draft);
      return;
    }
    const { seats, rooms } = opts.pickRoom(draft.members.length + 1);
    const id = saveTeamDraft({ team: draft, seats, rooms });
    close();
    opts.open(id, seats[0]);
  });

  document.getElementById('team-close')?.addEventListener('click', close);
  document.getElementById('team-cancel')?.addEventListener('click', close);
  modal.addEventListener('click', (ev) => {
    if (ev.target === modal) close();
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !modal.hidden) close();
  });

  return () => {
    say('');
    modal.hidden = false;
    fetchJson<TeamTemplatesResponse>('./api/dashboard/team-templates', opts.token)
      .then((data) => {
        defaultTeam = data.defaultTeam;
        templates = data.templates;
        renderTemplates('');
        useTemplate('');
        nameInput.focus();
      })
      .catch((err: unknown) => {
        say(`팀 정보를 불러오지 못했어요: ${String(err)}`);
      });
  };
}
