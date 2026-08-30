"use client";

import { RevenueCard } from "./RevenueCard";
import { PaymentsCard } from "./PaymentsCard";
import { AdjustmentsCard } from "./AdjustmentsCard";

export function FinancePanel() {
  return (
    <div className="grid-2">
      <div className="col">
        <RevenueCard />
      </div>
      <div className="col">
        <PaymentsCard />
        <AdjustmentsCard />
      </div>
    </div>
  );
}
