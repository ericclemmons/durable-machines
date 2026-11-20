import { registerObjects } from "@durable-machines/inspector";
import { ArrowsLeftRightIcon, BankIcon, CloudIcon, WalletIcon } from "@phosphor-icons/react";

registerObjects({
  Account: { icon: WalletIcon, name: "Account", purpose: "One per visitor: holds the balance and sets money aside for transfers" },
  Transfer: { icon: ArrowsLeftRightIcon, name: "Transfer", purpose: "One per transfer: the saga that moves the money" },
  Bank: { icon: BankIcon, name: "Bank", purpose: "The clearing house every visitor shares: one transfer at a time" },
  Worker: { icon: CloudIcon, name: "Worker", purpose: "Takes your commands" },
});
