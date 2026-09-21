import { useMemo } from 'react';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import {
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireTitle,
} from '@/components/ui/questionnaire';
import { AnswerBridge } from './answer-bridge';
import { supportedTimeZones, timeZoneLabel, useSetup } from './setup-state';

interface TimeZoneOption {
  value: string;
  label: string;
}

/** One question per item. Answers commit to setup memory on change so Back
 * preserves them; Questionnaire derives progress, focus, and required
 * validation from its native answer model. */
export function SchoolNameQuestion() {
  const { state, dispatch } = useSetup();

  return (
    <QuestionnaireItem name="school-name" required>
      <QuestionnaireTitle>What is your school called?</QuestionnaireTitle>
      <QuestionnaireDescription>
        Use the name staff and families will recognize.
      </QuestionnaireDescription>
      <QuestionnaireInput
        aria-label="School name"
        autoComplete="off"
        required
        value={state.school.name}
        onChange={(event) => {
          dispatch({ type: 'setSchool', school: { name: event.target.value } });
        }}
      />
      <QuestionnaireError />
    </QuestionnaireItem>
  );
}

/** Time zone uses the canonical shadcn Combobox as its answer control. The
 * hidden bridge mirrors the selection into the native answer model; only
 * zones from the IANA set can satisfy the item, and the server validates. */
export function SchoolTimeZoneQuestion() {
  const { state, dispatch } = useSetup();
  const zones = useMemo(() => supportedTimeZones(), []);
  const options = useMemo<TimeZoneOption[]>(
    () => zones.map((zone) => ({ value: zone, label: timeZoneLabel(zone) })),
    [zones],
  );
  const selected = options.find((option) => option.value === state.school.timeZone) ?? null;

  function commitTypedText(text: string): void {
    if (selected !== null) return;
    const typed = text.trim().toLowerCase();
    if (typed.length === 0) return;
    const exact = options.find(
      (option) => option.value.toLowerCase() === typed || option.label.toLowerCase() === typed,
    );
    if (exact) dispatch({ type: 'setSchool', school: { timeZone: exact.value } });
  }

  return (
    <QuestionnaireItem name="school-timezone" required>
      <QuestionnaireTitle>What time zone is your school in?</QuestionnaireTitle>
      <QuestionnaireDescription>
        WayPass uses this for class schedules and timestamps.
      </QuestionnaireDescription>
      <Combobox
        items={options}
        value={selected}
        onValueChange={(option: TimeZoneOption | null) => {
          dispatch({ type: 'setSchool', school: { timeZone: option?.value ?? '' } });
        }}
        onInputValueChange={commitTypedText}
        filter={(item: TimeZoneOption, query: string) =>
          `${item.label} ${item.value}`.toLowerCase().includes(query.toLowerCase())
        }
      >
        <ComboboxInput aria-label="Time zone" placeholder="Search time zones" />
        <ComboboxContent>
          <ComboboxList>
            {(item: TimeZoneOption) => (
              <ComboboxItem key={item.value} value={item}>
                {item.label}
              </ComboboxItem>
            )}
          </ComboboxList>
          <ComboboxEmpty>No matching time zone.</ComboboxEmpty>
        </ComboboxContent>
      </Combobox>
      <AnswerBridge value={state.school.timeZone} />
      <QuestionnaireError />
    </QuestionnaireItem>
  );
}
