/**
 * "새 팀" dialog: compose a team (MD plus members, a model each), optionally from a saved
 * template, then hand it to a new chat window where the user writes the first brief.
 */

import {
  fetchJson,
  postJson,
  saveTeamDraft,
  type TeamMember,
  type TeamRoster,
  type TeamTemplatesResponse,
} from './api.js';

const MODELS: Array<[string, string]> = [
  ['opus', 'Opus · 깊게'],
  ['sonnet', 'Sonnet · 균형'],
  ['haiku', 'Haiku · 빠름·저렴'],
];
const MAX_MEMBERS = 8;
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
  const addBtn = document.getElementById('team-add') as HTMLButtonElement | null;
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
    !addBtn
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

  const memberCard = (m: TeamMember, index: number): HTMLElement => {
    const label = el('input', { value: m.label, maxLength: 20, placeholder: '예: 마케터' });
    label.addEventListener('input', () => (m.label = label.value));
    const role = el('textarea', {
      value: m.role,
      maxLength: 500,
      rows: 2,
      placeholder: '한 줄로: 이 사람이 맡을 일',
    });
    role.addEventListener('input', () => (m.role = role.value));
    const model = modelSelect(m.model);
    model.addEventListener('change', () => (m.model = model.value));
    const remove = el('button', { type: 'button', className: 'team-remove' }, '빼기');
    remove.addEventListener('click', () => {
      team?.members.splice(index, 1);
      render();
    });
    return el(
      'li',
      { className: 'team-card' },
      el('div', { className: 'team-card-row' }, el('label', {}, '이름', label), model, remove),
      el('label', {}, '맡을 일', role),
    );
  };

  const leadCard = (t: TeamRoster): HTMLElement => {
    const label = el('input', { value: t.leadLabel, maxLength: 20 });
    label.addEventListener('input', () => (t.leadLabel = label.value));
    const model = modelSelect(t.leadModel);
    model.addEventListener('change', () => (t.leadModel = model.value));
    return el(
      'li',
      { className: 'team-card team-lead' },
      el('div', { className: 'team-card-row' }, el('label', {}, '팀장 이름', label), model),
      el(
        'p',
        { className: 'team-lead-note' },
        '대표님 지시를 받아 팀원에게 일을 나누고, 결과를 확인해서 보고해요.',
      ),
    );
  };

  function render(): void {
    if (!team) return;
    list?.replaceChildren(leadCard(team), ...team.members.map(memberCard));
    if (addBtn) addBtn.disabled = team.members.length >= MAX_MEMBERS;
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
    say('');
    render();
  };

  /** The dialog's team as the server takes it, or a reason it cannot go yet. */
  const collect = (): TeamRoster | string => {
    if (!team) return '팀 정보를 아직 못 불러왔어요.';
    const name = nameInput.value.trim();
    if (!name) return '팀 이름을 적어 주세요. 사무실 방 팻말에 이 이름이 붙어요.';
    if (!team.leadLabel.trim()) return '팀장 이름을 적어 주세요.';
    if (team.members.length === 0) return '팀원이 한 명은 있어야 해요.';
    const blank = team.members.find((m) => !m.label.trim() || !m.role.trim());
    if (blank) return '팀원마다 이름과 맡을 일을 적어 주세요.';
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

  addBtn.addEventListener('click', () => {
    if (!team || team.members.length >= MAX_MEMBERS) return;
    const taken = new Set(team.members.map((m) => m.key));
    let n = 1;
    while (taken.has(`member-${n}`)) n++;
    team.members.push({ key: `member-${n}`, label: '', role: NEW_MEMBER_ROLE, model: 'sonnet' });
    render();
    list.querySelector<HTMLInputElement>('.team-card:last-child input')?.focus();
  });

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
