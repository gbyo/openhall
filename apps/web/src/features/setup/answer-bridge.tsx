import { QuestionnaireInput } from '@/components/ui/questionnaire';

/** Bridges an answer the Questionnaire primitives cannot observe directly
 * into the native answer model: the selected value of a control such as
 * Combobox, or a constant for an answer-less item like review. The control
 * is hidden and never takes focus; progress, required validation, and
 * Enter-to-advance derive from it. */
export function AnswerBridge({ value }: { value: string }) {
  return <QuestionnaireInput value={value} readOnly hidden aria-hidden="true" tabIndex={-1} />;
}
