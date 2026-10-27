#!/usr/bin/env bash
# End-to-end smoke test for the HCM Lite backend (run against a FRESH database).
set -e
B=http://localhost:5000/api
JQ() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=process.argv[1].split('.').reduce((a,k)=>a?.[k],o);console.log(typeof v==='object'?JSON.stringify(v):v??'')}catch(e){console.log('PARSE_ERROR')}})" "$1"; }

echo "== 1. First-run setup (company + admin)"
ADMIN_TOKEN=$(curl -s -X POST $B/setup -H 'Content-Type: application/json' \
  -d '{"companyName":"Saylani Demo Pvt Ltd","name":"Shabbir Admin","email":"admin@saylani.pk","password":"admin123"}' | JQ token)
echo "admin token: ${ADMIN_TOKEN:0:20}..."

echo "== 2. Admin creates department, designation, leave types, holiday, HR user"
DEPT=$(curl -s -X POST $B/org/departments -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"name":"Engineering"}' | JQ _id)
DESIG=$(curl -s -X POST $B/org/designations -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"name":"Software Engineer"}' | JQ _id)
curl -s -X POST $B/org/leave-types/defaults -H "Authorization: Bearer $ADMIN_TOKEN" > /dev/null
NEXTMONDAY=$(node -e "const d=new Date();d.setDate(d.getDate()+((8-d.getDay())%7||7));console.log(d.toISOString().slice(0,10))")
curl -s -X POST $B/org/holidays -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d "{\"date\":\"$NEXTMONDAY\",\"name\":\"Company Day\"}" > /dev/null
echo "dept: $DEPT  designation: $DESIG"
HR=$(curl -s -X POST $B/users -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Hina HR\",\"email\":\"hr@saylani.pk\",\"password\":\"hr12345\",\"createProfile\":true,\"department\":\"$DEPT\"}")
HR_TEMP=$(echo "$HR" | JQ user.temporaryPassword 2>/dev/null)
echo "hr created: $(echo "$HR" | JQ user.email)"

echo "== 3. HR login"
HR_TOKEN=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d '{"email":"hr@saylani.pk","password":"hr12345"}' | JQ token)
echo "hr token: ${HR_TOKEN:0:20}..."

echo "== 4. HR registers two employees (logins created with temp passwords)"
E1=$(curl -s -X POST $B/employees -H "Authorization: Bearer $HR_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Ali Raza\",\"email\":\"ali@saylani.pk\",\"department\":\"$DEPT\",\"designation\":\"$DESIG\",\"joinDate\":\"2026-10-01\",\"basicSalary\":60000}")
E2=$(curl -s -X POST $B/employees -H "Authorization: Bearer $HR_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Sara Khan\",\"email\":\"sara@saylani.pk\",\"department\":\"$DEPT\",\"designation\":\"$DESIG\",\"joinDate\":\"2026-10-01\",\"basicSalary\":80000}")
E1_ID=$(echo "$E1" | JQ employee._id); E1_TEMP=$(echo "$E1" | JQ login.temporaryPassword)
E2_ID=$(echo "$E2" | JQ employee._id); E2_TEMP=$(echo "$E2" | JQ login.temporaryPassword)
echo "ali: $E1_ID temp=$E1_TEMP   sara: $E2_ID temp=$E2_TEMP"

echo "== 5. Employee signs in, changes password, checks in and out"
ALI_TOKEN=$(curl -s -X POST $B/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"ali@saylani.pk\",\"password\":\"$E1_TEMP\"}" | JQ token)
curl -s -X POST $B/auth/change-password -H "Authorization: Bearer $ALI_TOKEN" -H 'Content-Type: application/json' -d '{"currentPassword":"'$E1_TEMP'","newPassword":"ali12345"}' > /dev/null
curl -s -X POST $B/attendance/check-in -H "Authorization: Bearer $ALI_TOKEN" -H 'Content-Type: application/json' -d '{}' | JQ status
DUPLICATE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/attendance/check-in -H "Authorization: Bearer $ALI_TOKEN" -H 'Content-Type: application/json' -d '{}')
echo "duplicate check-in http code (expect 409): $DUPLICATE"
curl -s -X POST $B/attendance/check-out -H "Authorization: Bearer $ALI_TOKEN" -H 'Content-Type: application/json' -d '{}' | JQ status

echo "== 6. Employee applies leave (skips weekend/holiday), overlap + balance checks"
LTYPE=$(curl -s $B/leaves/types -H "Authorization: Bearer $ALI_TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s).find(x=>x.name==='Casual');console.log(t._id)})")
MON=$(node -e "const d=new Date();d.setDate(d.getDate()+((8-d.getDay())%7||7)+7);console.log(d.toISOString().slice(0,10))")
TUE=$(node -e "const d=new Date(process.argv[1]);d.setDate(d.getDate()+1);console.log(d.toISOString().slice(0,10))" "$MON")
LEAVE=$(curl -s -X POST $B/leaves -H "Authorization: Bearer $ALI_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"leaveTypeId\":\"$LTYPE\",\"start\":\"$MON\",\"end\":\"$TUE\",\"reason\":\"Sister's wedding\"}")
LEAVE_ID=$(echo "$LEAVE" | JQ _id); echo "leave $LEAVE_ID days=$(echo "$LEAVE" | JQ days)"
OVERLAP=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/leaves -H "Authorization: Bearer $ALI_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"leaveTypeId\":\"$LTYPE\",\"start\":\"$MON\",\"end\":\"$TUE\",\"reason\":\"again\"}")
echo "overlap http code (expect 422): $OVERLAP"

echo "== 7. HR approves; balance reflects"
curl -s -X PATCH $B/leaves/$LEAVE_ID/decision -H "Authorization: Bearer $HR_TOKEN" -H 'Content-Type: application/json' -d '{"action":"approve","comment":"Enjoy!"}' | JQ status
curl -s $B/leaves/balance -H "Authorization: Bearer $ALI_TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{JSON.parse(s).forEach(b=>console.log(b.name,'used',b.used,'left',b.remaining??'∞'))})"

echo "== 8. Attendance board + corrections"
curl -s "$B/attendance/board" -H "Authorization: Bearer $HR_TOKEN" | JQ counts
YDAY=$(node -e "const d=new Date();d.setDate(d.getDate()-1);console.log(d.toISOString().slice(0,10))")
curl -s -X POST $B/attendance/corrections -H "Authorization: Bearer $ALI_TOKEN" -H 'Content-Type: application/json' -d "{\"date\":\"$YDAY\",\"checkIn\":\"09:05\",\"checkOut\":\"18:00\",\"reason\":\"Forgot to check in\"}" | JQ status
CORR_ID=$(curl -s "$B/attendance/corrections?status=pending" -H "Authorization: Bearer $HR_TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0]._id))")
curl -s -X PATCH $B/attendance/corrections/$CORR_ID/decision -H "Authorization: Bearer $HR_TOKEN" -H 'Content-Type: application/json' -d '{"action":"approve"}' | JQ status

echo "== 9. Payroll: HR drafts current month, Admin finalizes, PDF downloads"
YEAR=$(date +%Y); MONTH=$(date +%-m)
RUN=$(curl -s -X POST $B/payroll/runs -H "Authorization: Bearer $HR_TOKEN" -H 'Content-Type: application/json' -d "{\"year\":$YEAR,\"month\":$MONTH}")
RUN_ID=$(echo "$RUN" | JQ _id); echo "run $RUN_ID totals: $(echo "$RUN" | JQ totals)"
curl -s -X PATCH $B/payroll/runs/$RUN_ID/finalize -H "Authorization: Bearer $ADMIN_TOKEN" | JQ status
RELOCK=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/payroll/runs -H "Authorization: Bearer $HR_TOKEN" -H 'Content-Type: application/json' -d "{\"year\":$YEAR,\"month\":$MONTH}")
echo "rebuild finalized run http code (expect 409): $RELOCK"
SLIP=$(curl -s $B/payroll/payslips/me -H "Authorization: Bearer $ALI_TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0]._id))")
curl -s -o /tmp/payslip.pdf -w "payslip pdf http %{http_code} size %{size_download}\n" $B/payroll/payslips/$SLIP/pdf -H "Authorization: Bearer $ALI_TOKEN"

echo "== 10. RBAC: employee blocked from others' salary/payroll/audit"
SARA_SLIP=$(curl -s -o /dev/null -w '%{http_code}' $B/payroll/runs -H "Authorization: Bearer $ALI_TOKEN")
AUDIT=$(curl -s -o /dev/null -w '%{http_code}' $B/comms/audit -H "Authorization: Bearer $ALI_TOKEN")
SETTINGS_PUT=$(curl -s -o /dev/null -w '%{http_code}' -X PUT $B/settings -H "Authorization: Bearer $HR_TOKEN" -H 'Content-Type: application/json' -d '{"companyName":"X"}')
echo "employee->payroll runs (expect 403): $SARA_SLIP   employee->audit (expect 403): $AUDIT   hr->settings put (expect 403): $SETTINGS_PUT"

echo "== 11. Dashboards for all roles"
curl -s $B/dashboards -H "Authorization: Bearer $ADMIN_TOKEN" | JQ kpis
curl -s $B/dashboards -H "Authorization: Bearer $HR_TOKEN" | JQ kpis | head -c 400; echo
curl -s $B/dashboards -H "Authorization: Bearer $ALI_TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log('hoursThisWeek',o.hoursThisWeek,'lateMonth',o.lateCountMonth,'balances',o.leaveBalances.length,'lastPayslip',!!o.lastPayslip)})"

echo "== 12. AI endpoints (no key configured -> friendly fallback)"
curl -s -X POST $B/ai/chat -H "Authorization: Bearer $ALI_TOKEN" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"Who is on leave today?"}]}' | head -c 200; echo
curl -s $B/ai/status -H "Authorization: Bearer $ALI_TOKEN"

echo; echo "== 13. CSV import dry-run with a bad row"
curl -s -X POST $B/employees/import/preview -H "Authorization: Bearer $HR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"csv":"code,name,email,department,joinDate,basicSalary\nEMP-900,Bilal,bilal@saylani.pk,Engineering,2026-10-05,50000\nEMP-901,,bad-email,UnknownDept,01-10-2026,abc"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log('total',o.total,'valid',o.valid,'invalid',o.invalid);o.results.filter(r=>!r.valid).forEach(r=>console.log('row',r.row,r.errors))})"

echo; echo "== 14. Audit log has entries"
curl -s "$B/comms/audit?limit=5" -H "Authorization: Bearer $ADMIN_TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log('total audit entries:',o.total);o.items.slice(0,5).forEach(i=>console.log(' -',i.action,i.entity))})"

echo; echo "ALL E2E CHECKS DONE"
