import { useState } from 'react';
import { format } from 'date-fns';
import {
  Alert02Icon,
  Calendar03Icon,
  Delete02Icon,
  InformationCircleIcon,
  MoreHorizontalCircle01Icon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Calendar } from '@/components/ui/calendar';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const tokenSwatches: [string, string, string][] = [
  ['Background', 'bg-background', 'text-foreground'],
  ['Muted', 'bg-muted', 'text-muted-foreground'],
  ['Accent', 'bg-accent', 'text-accent-foreground'],
  ['Primary', 'bg-primary', 'text-primary-foreground'],
];

function ReferenceSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-6 border-t py-10 first:border-t-0" id={id}>
      <div className="max-w-2xl space-y-2">
        <h2 className="font-heading text-2xl font-medium tracking-tight">{title}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function ReferenceExample({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function DatePickerExample() {
  const [date, setDate] = useState<Date>();

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            data-empty={!date}
            className="w-full justify-start text-left font-normal data-[empty=true]:text-muted-foreground"
          />
        }
      >
        <HugeiconsIcon data-icon="inline-start" icon={Calendar03Icon} strokeWidth={2} />
        {date ? format(date, 'PPP') : 'Pick a date'}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0">
        <Calendar mode="single" selected={date} onSelect={setDate} />
      </PopoverContent>
    </Popover>
  );
}

function TaskDialogExample() {
  const [isPending, setIsPending] = useState(false);

  return (
    <Dialog>
      <DialogTrigger render={<Button />}>New room</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New room</DialogTitle>
          <DialogDescription>
            Bounded create tasks stay over the workspace and preserve context.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="reference-room-name">Name</FieldLabel>
            <Input id="reference-room-name" defaultValue="Library" />
          </Field>
          <Field>
            <FieldLabel htmlFor="reference-room-mode">Check-in mode</FieldLabel>
            <Select defaultValue="optional">
              <SelectTrigger id="reference-room-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No check-in</SelectItem>
                <SelectItem value="optional">Optional</SelectItem>
                <SelectItem value="required">Required</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        <DialogFooter showCloseButton>
          <Button
            disabled={isPending}
            aria-busy={isPending}
            onClick={() => {
              setIsPending(true);
              window.setTimeout(() => {
                setIsPending(false);
              }, 1200);
            }}
          >
            {isPending ? <Spinner data-icon="inline-start" /> : null}
            {isPending ? 'Creating…' : 'Create room'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UIReferencePage() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b bg-background">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-12 sm:px-6 lg:px-8">
          <Badge variant="secondary" className="w-fit">
            Development reference · UI 0.3
          </Badge>
          <div className="max-w-3xl space-y-3">
            <h1 className="font-heading text-4xl font-medium tracking-tight sm:text-5xl">
              WayPass, built with shadcn Maia
            </h1>
            <p className="text-base leading-relaxed text-muted-foreground sm:text-lg">
              The canonical commodity layer is shadcn/ui base-maia on Base UI, with Public Sans,
              Hugeicons, a white canvas, and blue semantic product accents.
            </p>
          </div>
          <nav className="flex flex-wrap gap-2" aria-label="UI reference sections">
            {[
              ['#foundation', 'Foundation'],
              ['#controls', 'Controls'],
              ['#states', 'Async states'],
              ['#content', 'Content'],
              ['#surfaces', 'Task surfaces'],
            ].map(([href, label]) => (
              <Button
                key={href}
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<a href={href} />}
              >
                {label}
              </Button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
        <ReferenceSection
          id="foundation"
          title="Foundation"
          description="Semantic tokens carry the product theme. Feature code does not own alternate colors, radii, shadows, or control shapes."
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {tokenSwatches.map(([label, background, foreground]) => (
              <div className="space-y-2" key={label}>
                <div
                  className={`h-24 rounded-4xl border ${background} ${foreground} flex items-end p-4 text-sm font-medium`}
                >
                  {label}
                </div>
                <code className="text-xs text-muted-foreground">
                  {background.replace('bg-', '--')}
                </code>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge className="border-success/20 bg-success-subtle text-success">Ready</Badge>
            <Badge className="border-warning/20 bg-warning-subtle text-warning">Waiting</Badge>
            <Badge variant="destructive">Action required</Badge>
            <Badge variant="outline">Neutral</Badge>
          </div>
        </ReferenceSection>

        <ReferenceSection
          id="controls"
          title="Controls and fields"
          description="These are the generated Base UI components. Product features compose them directly instead of wrapping them in an OpenHall primitive API."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <ReferenceExample title="Buttons" description="Commands use the stock Maia variants.">
              <div className="flex flex-wrap gap-2">
                <Button>Create pass</Button>
                <Button variant="secondary">Review</Button>
                <Button variant="outline">Cancel</Button>
                <Button variant="ghost">More details</Button>
                <Button variant="destructive">Revoke</Button>
              </div>
              <Separator className="my-5" />
              <ButtonGroup>
                <Button variant="outline">Approve</Button>
                <Button variant="outline">Deny</Button>
              </ButtonGroup>
            </ReferenceExample>

            <ReferenceExample
              title="Form structure"
              description="Field owns labels, help, and errors."
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="reference-student">Student</FieldLabel>
                  <Input
                    id="reference-student"
                    defaultValue="Avery Johnson"
                    aria-describedby="reference-student-description"
                  />
                  <FieldDescription id="reference-student-description">
                    Use the name shown in the school directory.
                  </FieldDescription>
                </Field>
                <Field data-invalid="true">
                  <FieldLabel htmlFor="reference-room">Room</FieldLabel>
                  <Input
                    id="reference-room"
                    aria-invalid="true"
                    aria-describedby="reference-room-error"
                  />
                  <FieldError id="reference-room-error">Choose a room.</FieldError>
                </Field>
              </FieldGroup>
            </ReferenceExample>

            <ReferenceExample
              title="Search and local activity"
              description="Network-backed search stays interactive while it refreshes."
            >
              <Field>
                <FieldLabel htmlFor="reference-search">Search people</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <InputGroupText>
                      <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
                    </InputGroupText>
                  </InputGroupAddon>
                  <InputGroupInput
                    id="reference-search"
                    defaultValue="Avery"
                    aria-describedby="reference-search-description"
                  />
                  <InputGroupAddon align="inline-end">
                    <Spinner aria-label="Refreshing results" />
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription id="reference-search-description">
                  Current results remain visible during refresh.
                </FieldDescription>
              </Field>
            </ReferenceExample>

            <ReferenceExample title="Choice semantics">
              <FieldSet>
                <FieldLegend variant="label">Room settings</FieldLegend>
                <Field orientation="horizontal">
                  <Checkbox id="reference-notify" defaultChecked />
                  <FieldLabel htmlFor="reference-notify">
                    Notify staff when the student arrives
                  </FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <Switch id="reference-queue" defaultChecked />
                  <FieldLabel htmlFor="reference-queue">Queue enabled</FieldLabel>
                </Field>
                <DatePickerExample />
              </FieldSet>
            </ReferenceExample>
          </div>
        </ReferenceSection>

        <ReferenceSection
          id="states"
          title="Async and feedback states"
          description="Initial loading, local pending work, measurable progress, persistent errors, and confirmed empty results have distinct treatments."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <ReferenceExample title="Button pending state">
              <Button disabled aria-busy="true">
                <Spinner data-icon="inline-start" />
                Saving…
              </Button>
            </ReferenceExample>

            <ReferenceExample
              title="Initial loading"
              description="Skeletons match the eventual item shape."
            >
              <div className="space-y-3" role="status" aria-label="Loading rooms" aria-busy="true">
                {[0, 1, 2].map((row) => (
                  <div className="flex items-center gap-3" key={row}>
                    <Skeleton className="size-10 rounded-xl" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-2/5" />
                      <Skeleton className="h-3 w-3/5" />
                    </div>
                  </div>
                ))}
              </div>
            </ReferenceExample>

            <ReferenceExample title="Persistent feedback">
              <div className="space-y-3">
                <Alert>
                  <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} />
                  <AlertTitle>Checking for the latest pass state</AlertTitle>
                  <AlertDescription>
                    Confirmed information stays visible while the background refresh completes.
                  </AlertDescription>
                </Alert>
                <Alert variant="destructive">
                  <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
                  <AlertTitle>We could not save this change</AlertTitle>
                  <AlertDescription>
                    Your draft is still here. Review the error and try again.
                  </AlertDescription>
                </Alert>
              </div>
            </ReferenceExample>

            <ReferenceExample title="Measured progress and toast">
              <div className="space-y-5">
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>Roster import</span>
                    <span className="text-muted-foreground">64%</span>
                  </div>
                  <Progress value={64} aria-label="Roster import is 64 percent complete" />
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    toast.success('Invitation copied');
                  }}
                >
                  Show brief confirmation
                </Button>
              </div>
            </ReferenceExample>

            <ReferenceExample
              title="Confirmed empty result"
              description="Empty never appears during loading."
            >
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
                  </EmptyMedia>
                  <EmptyTitle>No matching students</EmptyTitle>
                  <EmptyDescription>Try another name or clear the active filters.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline">Clear filters</Button>
                </EmptyContent>
              </Empty>
            </ReferenceExample>
          </div>
        </ReferenceSection>

        <ReferenceSection
          id="content"
          title="Task-appropriate content"
          description="Readable action lists use Item. Dense relational data uses Table. Card is reserved for a bounded object or group."
        >
          <Tabs defaultValue="items">
            <TabsList>
              <TabsTrigger value="items">Items</TabsTrigger>
              <TabsTrigger value="table">Table</TabsTrigger>
              <TabsTrigger value="card">Card</TabsTrigger>
            </TabsList>
            <TabsContent value="items" className="pt-4">
              <ItemGroup>
                {[
                  ['Library', 'Open until 3:30 PM', 'Available'],
                  ['Counseling office', 'Staff review required', 'Review'],
                ].map(([title, description, status]) => (
                  <Item variant="outline" role="listitem" key={title}>
                    <ItemMedia variant="icon">
                      <span className="size-2 rounded-full bg-primary" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{title}</ItemTitle>
                      <ItemDescription>{description}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Badge variant="secondary">{status}</Badge>
                      <Button size="sm">Start</Button>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            </TabsContent>
            <TabsContent value="table" className="pt-4">
              <div className="overflow-hidden rounded-2xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Student</TableHead>
                      <TableHead>Room</TableHead>
                      <TableHead>State</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell className="font-medium">Avery Johnson</TableCell>
                      <TableCell>Library</TableCell>
                      <TableCell>
                        <Badge variant="secondary">Out</Badge>
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
            <TabsContent value="card" className="pt-4">
              <Card className="max-w-lg">
                <CardHeader>
                  <CardTitle>Library WayPass</CardTitle>
                  <CardDescription>Avery Johnson · started 8 minutes ago</CardDescription>
                  <CardAction>
                    <Badge className="border-success/20 bg-success-subtle text-success">
                      Active
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    One prominent card represents the active pass; supporting sections remain quiet.
                  </p>
                </CardContent>
                <CardFooter>
                  <Button>Start return</Button>
                </CardFooter>
              </Card>
            </TabsContent>
          </Tabs>
        </ReferenceSection>

        <ReferenceSection
          id="surfaces"
          title="Task surfaces"
          description="Dialog handles bounded work, Drawer is its mobile counterpart, Sheet preserves list context, and AlertDialog confirms consequential actions."
        >
          <div className="flex flex-wrap gap-2">
            <TaskDialogExample />

            <Drawer>
              <DrawerTrigger render={<Button variant="outline" />}>Open mobile task</DrawerTrigger>
              <DrawerContent>
                <DrawerHeader>
                  <DrawerTitle>Create pass</DrawerTitle>
                  <DrawerDescription>A bottom task surface for narrow screens.</DrawerDescription>
                </DrawerHeader>
                <div className="px-4 pb-6">
                  <Field>
                    <FieldLabel htmlFor="reference-mobile-room">Room</FieldLabel>
                    <Input id="reference-mobile-room" defaultValue="Library" />
                  </Field>
                </div>
                <DrawerFooter>
                  <Button>Create pass</Button>
                  <DrawerClose render={<Button variant="outline" />}>Cancel</DrawerClose>
                </DrawerFooter>
              </DrawerContent>
            </Drawer>

            <Sheet>
              <SheetTrigger render={<Button variant="outline" />}>Inspect person</SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Avery Johnson</SheetTitle>
                  <SheetDescription>
                    Identity and affiliation details stay beside the directory.
                  </SheetDescription>
                </SheetHeader>
                <div className="px-6">
                  <Item variant="muted">
                    <ItemContent>
                      <ItemTitle>Student</ItemTitle>
                      <ItemDescription>Grade 10 · Active enrollment</ItemDescription>
                    </ItemContent>
                  </Item>
                </div>
                <SheetFooter>
                  <Button>Generate invitation</Button>
                </SheetFooter>
              </SheetContent>
            </Sheet>

            <AlertDialog>
              <AlertDialogTrigger render={<Button variant="destructive" />}>
                Revoke access
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogMedia>
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  </AlertDialogMedia>
                  <AlertDialogTitle>Revoke this staff grant?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The person will immediately lose the capabilities provided by this grant.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep access</AlertDialogCancel>
                  <AlertDialogAction variant="destructive">Revoke access</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="icon" />}>
                <HugeiconsIcon icon={MoreHorizontalCircle01Icon} strokeWidth={2} />
                <span className="sr-only">Open row actions</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Row actions</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem>Edit room</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive">Archive room</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <Tooltip>
              <TooltipTrigger render={<Button variant="outline" size="icon" />}>
                <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} />
                <span className="sr-only">About uncertain commands</span>
              </TooltipTrigger>
              <TooltipContent>Supplemental explanation only</TooltipContent>
            </Tooltip>
          </div>
        </ReferenceSection>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-8 text-sm text-muted-foreground sm:px-6 lg:px-8">
          <span>OpenHall UI 0.3 foundation</span>
          <span>Base UI · shadcn base-maia · Tailwind CSS v4 · Hugeicons · Public Sans</span>
        </div>
      </footer>
    </div>
  );
}
