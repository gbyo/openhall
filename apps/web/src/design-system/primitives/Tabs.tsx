import {
  Tab,
  TabList,
  TabPanel,
  Tabs as AriaTabs,
  type Key,
  type TabsProps as AriaTabsProps,
} from 'react-aria-components';
import type { ReactNode } from 'react';

export interface TabDefinition {
  id: Key;
  label: string;
  content: ReactNode;
}

export interface TabsProps extends Omit<AriaTabsProps, 'children' | 'className'> {
  label: string;
  tabs: TabDefinition[];
}

export function Tabs({ label, tabs, ...props }: TabsProps) {
  return (
    <AriaTabs {...props} className="wf-tabs">
      <TabList aria-label={label} className="wf-tabs__list" items={tabs}>
        {(tab) => <Tab className="wf-tabs__tab">{tab.label}</Tab>}
      </TabList>
      {tabs.map((tab) => (
        <TabPanel className="wf-tabs__panel" id={tab.id} key={tab.id}>
          {tab.content}
        </TabPanel>
      ))}
    </AriaTabs>
  );
}
