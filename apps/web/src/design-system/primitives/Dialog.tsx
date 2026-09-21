import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger,
  Heading,
  Modal,
  ModalOverlay,
} from 'react-aria-components';

export interface DialogProps {
  trigger: ReactNode;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm?: () => void;
}

export function Dialog({ trigger, title, children, confirmLabel, onConfirm }: DialogProps) {
  return (
    <DialogTrigger>
      <AriaButton className="wf-button wf-button--danger wf-button--standard">{trigger}</AriaButton>
      <ModalOverlay className="wf-modal-overlay" isDismissable>
        <Modal className="wf-modal">
          <AriaDialog className="wf-dialog">
            {({ close }) => (
              <>
                <Heading slot="title" className="wf-type-heading">
                  {title}
                </Heading>
                <div className="wf-dialog__body">{children}</div>
                <div className="wf-dialog__actions">
                  <AriaButton
                    className="wf-button wf-button--secondary wf-button--standard"
                    onPress={close}
                  >
                    Cancel
                  </AriaButton>
                  <AriaButton
                    className="wf-button wf-button--danger wf-button--standard"
                    onPress={() => {
                      onConfirm?.();
                      close();
                    }}
                  >
                    {confirmLabel}
                  </AriaButton>
                </div>
              </>
            )}
          </AriaDialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
