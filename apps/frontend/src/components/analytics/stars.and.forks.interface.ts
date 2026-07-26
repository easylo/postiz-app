export interface StarsList {
  totalStars: number;
  date: string;
}
export interface TotalList {
  // The analytics API sends totals as strings; ChartSocial coerces before it
  // adds or plots them. Typing this as a number is what let a concatenation
  // pass for an addition.
  total: string | number;
  date: string;
}
export interface ForksList {
  totalForks: number;
  date: string;
}
export interface Stars {
  id: string;
  stars: number;
  totalStars: number;
  login: string;
  date: string;
}
export interface StarsAndForksInterface {
  list: Array<{
    login: string;
    stars: StarsList[];
    forks: ForksList[];
  }>;
  trending: {
    last: string;
    predictions: string;
  };
}
