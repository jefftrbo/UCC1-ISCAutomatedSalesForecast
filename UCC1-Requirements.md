1- We need the ability to extract current sales forecast data from ISC in preparation for our Sales VP's weekly meeting w US Public Sector General Manager (GM)
2- In a perfect scenario, I'd like to provide you w a URL to the ISC web page that would act as a source of that data, providing you w the fields that I need extracted to be stored an appropriate datastore of your choice
3- Once the data is stored, I need you to create a simple web page that would give our Sales VP to choose which sales opportunities to include in this week's GM meeting
4- create an executive business appropriate powerpoint containing that information

The Key Questions I Need Answered
Before I can write a plan, I need your input on the biggest unknowns:

How is the ISC sales forecast data actually accessible? This determines everything about the data extraction approach. 



ISC has a web page I can give you a URL to — I expect you to scrape or parse it (we can handle the IBM w3id SSO login separately)
<myanswer> I don't have access to any ISC API's, so if I were to login w my IBM SSO credentials then give you that URL, would you be able to access it?  If "no", can I invoke the code you may write directly from another URL to kick off your scrape process?


ISC supports data export (CSV or Excel download) — I can provide a sample export file as the input source
<myanswer>ISC does not support data export because IBM's senior execs want to eliminate xls based reporting and conduct such reporting "off of the ISC glass"


ISC has a REST API or Salesforce-based API that we can call with credentials
<myanswer>No


I'm not sure yet — let's design the system so the data source can be swapped in later, and start with a mock/sample dataset