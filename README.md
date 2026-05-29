# FundSentinel

Backend real-data work currently includes official/public providers for CSRC disclosure, AMAC statistics, CNInfo listed-fund reports, and per-company fund pages. The fund-company adapters now cover CMF China, HuaAn, E Fund, ChinaAMC, Harvest, and Fullgoal; each adapter records source URLs and keeps trading, account, payment, and brokerage paths out of scope.

Fullgoal coverage uses public pages such as `https://www.fullgoal.com.cn/fundDetail/161005/index.html?isdividend=1` and announcement detail pages under `/noticedetails/{id}/index.html` to collect fund metadata, current NAV, NAV history rows, and verified PDF metadata for official reports.
