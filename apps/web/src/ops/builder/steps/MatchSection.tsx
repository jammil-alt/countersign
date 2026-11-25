// The Match settings (docs/step-model-plan.md §7), shown when a Do step uses a Match. The profile
// fixes the keys it allows and its "never the same if" rules; the step sets the rest.

import { steps } from "@countersign/core";
import { Button } from "../../../ui/primitives";
import { SmallInput, SmallSelect } from "../fields";
import type { StepFormProps } from "./form-kit";
import { changeProfile, changeType, MATCH_TYPE_WORDS, moveKey, percent } from "./match-model";
import { SuggestButton } from "./SuggestButton";
import type { DoStep, MatchSettings } from "./types";

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 text-sm text-ink">
      <span>{label}</span>
      {children}
    </div>
  );
}

export function MatchSection({ step, env, onChange }: StepFormProps<DoStep>) {
  if (step.uses?.type !== "match") return null;
  const m = step.uses.match;
  const profile = env.uses.profiles.find((p) => p.id === m.to);
  const set = (next: MatchSettings) => onChange({ ...step, uses: { type: "match", match: next } });
  const suggest = (field: string, label: string) => (
    <SuggestButton
      step={step}
      field={field}
      label={label}
      suggest={env.suggest}
      onApply={(s) => onChange(s as DoStep)}
    />
  );
  const problems = profile ? steps.matchSettingsProblems(m, profile) : [];
  const keys = m.keys ?? profile?.keys.map((k) => k.id) ?? [];
  const keyName = (id: string) => profile?.keys.find((k) => k.id === id)?.name ?? id;
  const semantic = m.type !== "exact";
  const pct = (
    value: number | undefined,
    apply: (n: number | undefined) => void,
    label: string,
    optional = false,
  ) => (
    <SmallInput
      aria-label={label}
      inputMode="numeric"
      defaultValue={value ?? ""}
      key={`${label}-${value ?? ""}`}
      onBlur={(e) => {
        const text = e.target.value.trim();
        if (optional && text === "") return apply(undefined);
        const n = percent(text);
        if (n === undefined) e.target.value = String(value ?? "");
        else apply(n);
      }}
    />
  );

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4" data-testid="match-settings">
      <div className="flex items-center justify-between">
        <h3 className="eyebrow text-ink-muted">Match settings</h3>
        {suggest("uses.match", "Match settings")}
      </div>

      <Line label="Match to">
        <SmallSelect
          aria-label="Match to"
          value={m.to}
          onChange={(e) => {
            const next = env.uses.profiles.find((p) => p.id === e.target.value);
            if (next) set(changeProfile(m, next));
          }}
        >
          {profile ? null : <option value={m.to}>{m.to}</option>}
          {env.uses.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </SmallSelect>
      </Line>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Line label="Match type">
            <SmallSelect
              aria-label="Match type"
              value={m.type}
              onChange={(e) => set(changeType(m, e.target.value as MatchSettings["type"]))}
            >
              {steps.MATCH_TYPES.map((t) => (
                <option key={t} value={t} disabled={profile ? !profile.types.includes(t) : false}>
                  {MATCH_TYPE_WORDS[t]}
                </option>
              ))}
            </SmallSelect>
          </Line>
        </div>
        {suggest("uses.match.type", "Match type")}
      </div>

      {profile ? (
        <div className="flex flex-col gap-1" data-testid="match-keys">
          <span className="text-sm text-ink">Keys, in order</span>
          {keys.map((k, i) => (
            <div key={k} className="flex items-center gap-2 text-sm">
              <span className="w-5 text-ink-muted">{i + 1}</span>
              <span className="flex-1 text-ink">{keyName(k)}</span>
              <Button
                size="sm"
                aria-label={`Move ${keyName(k)} up`}
                disabled={i === 0}
                onClick={() => set({ ...m, keys: moveKey(keys, i, -1) })}
              >
                Up
              </Button>
              <Button
                size="sm"
                aria-label={`Move ${keyName(k)} down`}
                disabled={i === keys.length - 1}
                onClick={() => set({ ...m, keys: moveKey(keys, i, 1) })}
              >
                Down
              </Button>
              {keys.length > 1 ? (
                <Button
                  size="sm"
                  aria-label={`Leave out ${keyName(k)}`}
                  onClick={() => set({ ...m, keys: keys.filter((x) => x !== k) })}
                >
                  Leave out
                </Button>
              ) : null}
            </div>
          ))}
          {profile.keys
            .filter((k) => !keys.includes(k.id))
            .map((k) => (
              <Button
                key={k.id}
                size="sm"
                className="self-start"
                onClick={() => set({ ...m, keys: [...keys, k.id] })}
              >
                Add {k.name}
              </Button>
            ))}
        </div>
      ) : null}

      {semantic ? (
        <>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Line label="Confidence threshold (%)">
                {pct(
                  m.confidenceThreshold,
                  (n) => n !== undefined && set({ ...m, confidenceThreshold: n }),
                  "Confidence threshold",
                )}
              </Line>
            </div>
            {suggest("uses.match.confidenceThreshold", "Confidence threshold")}
          </div>

          <div className="flex flex-col gap-2" data-testid="match-second-opinion">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={m.secondOpinion !== undefined}
                onChange={(e) => {
                  if (e.target.checked) {
                    set({
                      ...m,
                      secondOpinion: {
                        from: Math.min(70, m.confidenceThreshold - 1),
                        by: "ai_then_person",
                      },
                    });
                  } else {
                    const { secondOpinion: _s, ...rest } = m;
                    set(rest);
                  }
                }}
              />
              Second opinion between a lower level and the threshold
            </label>
            {m.secondOpinion ? (
              <div className="flex gap-2 pl-6">
                <Line label="From (%)">
                  {pct(
                    m.secondOpinion.from,
                    (n) =>
                      n !== undefined &&
                      m.secondOpinion &&
                      set({ ...m, secondOpinion: { ...m.secondOpinion, from: n } }),
                    "Second opinion from",
                  )}
                </Line>
                <Line label="By">
                  <SmallSelect
                    aria-label="Second opinion by"
                    value={m.secondOpinion.by}
                    onChange={(e) =>
                      m.secondOpinion &&
                      set({
                        ...m,
                        secondOpinion: {
                          ...m.secondOpinion,
                          by: e.target.value as "ai" | "person" | "ai_then_person",
                        },
                      })
                    }
                  >
                    <option value="ai">AI</option>
                    <option value="person">A person</option>
                    <option value="ai_then_person">AI, then a person if they disagree</option>
                  </SmallSelect>
                </Line>
              </div>
            ) : null}
          </div>

          <Line label="Below the floor">
            <SmallSelect
              aria-label="Below the floor"
              value={m.belowFloor}
              onChange={(e) =>
                set({ ...m, belowFloor: e.target.value as MatchSettings["belowFloor"] })
              }
            >
              <option value="person">A person decides</option>
              <option value="no_match">No match</option>
              <option value="new">It is new</option>
            </SmallSelect>
          </Line>

          <Line label="Search too weak (%, optional)">
            {pct(
              m.searchFloor,
              (n) => {
                const { searchFloor: _f, ...rest } = m;
                set(n === undefined ? rest : { ...rest, searchFloor: n });
              },
              "Search too weak",
              true,
            )}
          </Line>

          <div className="flex gap-2">
            <Line label="Shortlist the model sees (up to 50)">
              <SmallInput
                aria-label="Shortlist the model sees"
                inputMode="numeric"
                key={`model-${m.shortlist.model}`}
                defaultValue={m.shortlist.model}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n >= 1 && n <= 50)
                    set({ ...m, shortlist: { ...m.shortlist, model: n } });
                  else e.target.value = String(m.shortlist.model);
                }}
              />
            </Line>
            <Line label="Shortlist a person sees (up to 10)">
              <SmallInput
                aria-label="Shortlist a person sees"
                inputMode="numeric"
                key={`person-${m.shortlist.person}`}
                defaultValue={m.shortlist.person}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n >= 1 && n <= 10)
                    set({ ...m, shortlist: { ...m.shortlist, person: n } });
                  else e.target.value = String(m.shortlist.person);
                }}
              />
            </Line>
          </div>
        </>
      ) : null}

      <Line label="No match means">
        <SmallSelect
          aria-label="No match means"
          value={m.noMatch}
          onChange={(e) => set({ ...m, noMatch: e.target.value as MatchSettings["noMatch"] })}
        >
          <option value="not_found">Not found</option>
          <option value="new">New</option>
          <option value="person">Ask a person</option>
        </SmallSelect>
      </Line>

      {problems.length > 0 ? (
        <ul className="text-sm text-risk-ink" role="alert" data-testid="match-problems">
          {problems.map((p) => (
            <li key={p}>Needs fixing: {p}.</li>
          ))}
        </ul>
      ) : null}

      {profile ? (
        <div
          className="flex flex-col gap-1 border border-line p-2 text-sm"
          data-testid="match-profile-info"
        >
          <span className="eyebrow text-ink-muted">Set by the area that owns the records</span>
          <span className="text-ink">
            Keys allowed: {profile.keys.map((k) => k.name).join(", ")}
          </span>
          {profile.neverSame.length > 0 ? (
            <span className="text-ink">
              Never the same if: {profile.neverSame.map((n) => n.words).join("; ")}
            </span>
          ) : null}
          {profile.learns ? <span className="text-ink">A person's answer is learned.</span> : null}
        </div>
      ) : null}
    </section>
  );
}
