import type { CategoryPrinters, KitchenTicket, KitchenTicketLine, OrderLine, Printer } from './types'

/** What a Valider sends: one ticket per printer concerned, and the lines whose category has no printer. */
export interface SendResult {
  tickets: KitchenTicket[]
  /** New lines that no printer receives (their category has none, or the item was deleted). */
  unrouted: KitchenTicketLine[]
}

export interface TicketContext {
  orderId: string
  tableLabel: string | null
  waiter: string
  /** Time of the Valider. */
  at: string
}

export const ticketLine = (l: OrderLine): KitchenTicketLine => ({
  name: l.name,
  quantity: l.quantity,
  options: l.options.map((o) => o.name),
  note: l.note || null,
})

/**
 * Splits the lines just sent across printers by the category of their item.
 * A category linked to two printers puts its lines on both tickets. Tickets follow the printers' order.
 */
export function buildKitchenTickets(
  lines: OrderLine[],
  itemCategory: Record<string, string>,
  categoryPrinters: CategoryPrinters,
  printers: Printer[],
  ctx: TicketContext,
): Omit<SendResult, 'tickets'> & { tickets: Omit<KitchenTicket, 'id'>[] } {
  const byPrinter = new Map<string, KitchenTicketLine[]>()
  const unrouted: KitchenTicketLine[] = []
  const known = new Set(printers.map((p) => p.id))
  for (const l of [...lines].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const category = l.item_id ? itemCategory[l.item_id] : undefined
    const targets = (category ? categoryPrinters[category] ?? [] : []).filter((id) => known.has(id))
    if (!targets.length) unrouted.push(ticketLine(l))
    for (const id of new Set(targets)) {
      const list = byPrinter.get(id) ?? []
      list.push(ticketLine(l))
      byPrinter.set(id, list)
    }
  }
  const tickets = [...printers]
    .sort((a, b) => a.sort_order - b.sort_order)
    .filter((p) => byPrinter.has(p.id))
    .map((p) => ({
      order_id: ctx.orderId,
      printer_id: p.id,
      printer_name: p.name,
      table_label: ctx.tableLabel,
      waiter: ctx.waiter,
      created_at: ctx.at,
      lines: byPrinter.get(p.id)!,
      printed_at: null,
    }))
  return { tickets, unrouted }
}

/**
 * Where kitchen tickets go once they exist. Today only the on-screen preview (printable from the browser)
 * is used; a network driver can later send ESC/POS bytes to `printer.ip:printer.port` (through a small
 * print bridge on the restaurant network, since browsers cannot open raw TCP sockets) and then mark the
 * ticket printed, without changing how tickets are built or stored.
 */
export interface PrintDriver {
  /** True when this driver can print on that printer (e.g. it has an IP address). */
  canPrint(printer: Printer): boolean
  print(ticket: KitchenTicket, printer: Printer): Promise<void>
}

/** Printing drivers, tried in order. Empty for now: every ticket is shown in the preview instead. */
export const printDrivers: PrintDriver[] = []

/** Sends each ticket to the first driver able to print it; returns the tickets left for the preview. */
export async function dispatchTickets(tickets: KitchenTicket[], printers: Printer[]): Promise<KitchenTicket[]> {
  const left: KitchenTicket[] = []
  for (const ticket of tickets) {
    const printer = printers.find((p) => p.id === ticket.printer_id)
    const driver = printer && printDrivers.find((d) => d.canPrint(printer))
    if (!printer || !driver) {
      left.push(ticket)
      continue
    }
    try {
      await driver.print(ticket, printer)
    } catch {
      left.push(ticket)
    }
  }
  return left
}
